#include "PluginProcessor.h"
#include "PluginEditor.h"

EarshotAudioProcessor::EarshotAudioProcessor()
    : AudioProcessor (BusesProperties()
        .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
        .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      takeWriter (captureBuffer)
{
    takeWriter.onTakeSaved = [this] (const TakeRecord& rec)
    {
        uploader.enqueue (rec.file, projectName, rec.durationSec);
    };
    // Apply defaults to all the background workers before they start.
    setBackendBase (backendBase);
    setAuthToken (authToken);

    uploader.start();
    healthPoller.start();
    takesPoller.setProjectSlug (juce::String()); // set properly below
    takesPoller.start();

    // Keep the takes poller's project slug in sync with whatever project
    // the user names this instance. The slug must match the backend's
    // slug() function exactly so URLs resolve.
    setProjectName (projectName);
}

EarshotAudioProcessor::~EarshotAudioProcessor()
{
    takeWriter.onTakeSaved = nullptr;
    takeWriter.stop();
    uploader.stop();
    healthPoller.stop();
    takesPoller.stop();
}

void EarshotAudioProcessor::prepareToPlay (double sampleRate, int /*samplesPerBlock*/)
{
    captureBuffer.reset();
    takeWriter.setProjectName (projectName);
    takeWriter.setSampleRate (sampleRate);
    if (! takeWriter.isThreadRunning())
        takeWriter.start (sampleRate);
}

bool EarshotAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto mainOut = layouts.getMainOutputChannelSet();
    if (mainOut != juce::AudioChannelSet::mono()
        && mainOut != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == mainOut;
}

void EarshotAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const int n = buffer.getNumSamples();
    const int numIn = buffer.getNumChannels();

    // Always observe the input — drives the level meter so the user can see
    // audio is actually reaching the plugin even when not recording.
    if (n > 0 && numIn > 0)
    {
        const float* l = buffer.getReadPointer (0);
        const float* r = numIn > 1 ? buffer.getReadPointer (1) : l;

        float pl = peakL.load() * peakDecay;
        float pr = peakR.load() * peakDecay;
        for (int i = 0; i < n; ++i)
        {
            pl = juce::jmax (pl, std::abs (l[i]));
            pr = juce::jmax (pr, std::abs (r[i]));
        }
        peakL.store (pl);
        peakR.store (pr);

        // Arm-and-wait: a take runs only when the user has armed AND the
        // host transport is playing. Transport stop auto-ends and unarms.
        bool hostPlaying = false;
        if (auto* ph = getPlayHead())
            if (auto pos = ph->getPosition())
                hostPlaying = pos->getIsPlaying();

        const bool armed       = armRequested.load (std::memory_order_acquire);
        const bool shouldCapture = armed && hostPlaying;

        if (shouldCapture && ! prevCapturing)
        {
            framesCapturedThisTake.store (0);
            capturing.store (true, std::memory_order_release);
            takeWriter.arm();
        }
        else if (! shouldCapture && prevCapturing)
        {
            capturing.store (false, std::memory_order_release);
            takeWriter.disarm();
            // Auto-unarm: transport stopping ends both the take and the
            // armed state, so the next play-through won't be captured
            // unless the user hits record again.
            armRequested.store (false, std::memory_order_release);
        }
        prevCapturing = shouldCapture;

        if (shouldCapture)
        {
            const int pushed = captureBuffer.push (l, r, n);
            framesCapturedThisTake.fetch_add (pushed);
        }
    }

    // Pure pass-through; we only observe audio, never modify it.
}

juce::AudioProcessorEditor* EarshotAudioProcessor::createEditor()
{
    return new EarshotAudioProcessorEditor (*this);
}

static juce::String makeSlug (const juce::String& s)
{
    // Matches backend slug() exactly.
    juce::String out;
    bool lastDash = true;
    for (auto cp : s.toLowerCase())
    {
        bool alnum = (cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9');
        if (alnum) { out += juce::String::charToString (cp); lastDash = false; }
        else if (! lastDash) { out += '-'; lastDash = true; }
    }
    while (out.endsWithChar ('-')) out = out.dropLastCharacters (1);
    return out.isEmpty() ? juce::String ("untitled") : out;
}

void EarshotAudioProcessor::setProjectName (const juce::String& name)
{
    projectName = name;
    takeWriter.setProjectName (name);
    takesPoller.setProjectSlug (makeSlug (name));
}

void EarshotAudioProcessor::setBackendBase (const juce::String& url)
{
    backendBase = url.trim();
    if (backendBase.endsWithChar ('/')) backendBase = backendBase.dropLastCharacters (1);
    // Propagate to anything that targets the backend.
    healthPoller.setBackendBase (juce::URL (backendBase));
    takesPoller.setBackendBase  (juce::URL (backendBase));
    uploader.setEndpoint        (juce::URL (backendBase + "/takes"));
}

// Decode a base64url JWT payload to extract a single string claim.
// We intentionally don't verify the signature here — the backend does
// that on every request; the plugin just trusts whatever it persisted.
static juce::String jwtClaim (const juce::String& jwt, const juce::String& key)
{
    auto firstDot  = jwt.indexOfChar ('.');
    if (firstDot < 0) return {};
    auto secondDot = jwt.indexOfChar (firstDot + 1, '.');
    if (secondDot < 0) return {};
    auto payload = jwt.substring (firstDot + 1, secondDot);
    // base64url → base64
    payload = payload.replaceCharacter ('-', '+').replaceCharacter ('_', '/');
    while (payload.length() % 4 != 0) payload += "=";
    juce::MemoryOutputStream out;
    if (! juce::Base64::convertFromBase64 (out, payload)) return {};
    auto json = juce::String::fromUTF8 ((const char*) out.getData(), (int) out.getDataSize());
    auto v = juce::JSON::parse (json);
    if (auto* obj = v.getDynamicObject())
        return obj->getProperty (key).toString();
    return {};
}

void EarshotAudioProcessor::setAuthToken (const juce::String& tok)
{
    authToken = tok.trim();
    userEmail = authToken.isNotEmpty() ? jwtClaim (authToken, "email") : juce::String();
    uploader.setAuthToken     (authToken);
    healthPoller.setAuthToken (authToken);
    takesPoller.setAuthToken  (authToken);
}

void EarshotAudioProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    // Persist as JSON inside the host's saved project. JSON lets us add
    // fields later without breaking older saved states.
    juce::DynamicObject::Ptr obj = new juce::DynamicObject();
    obj->setProperty ("projectName", projectName);
    obj->setProperty ("backendBase", backendBase);
    obj->setProperty ("authToken",   authToken);
    auto json = juce::JSON::toString (juce::var (obj.get()), false);
    dest.replaceAll (json.toRawUTF8(), json.getNumBytesAsUTF8());
}

void EarshotAudioProcessor::setStateInformation (const void* data, int size)
{
    juce::String json (juce::CharPointer_UTF8 ((const char*) data),
                       (size_t) juce::jmax (0, size));
    auto parsed = juce::JSON::parse (json);
    if (auto* obj = parsed.getDynamicObject())
    {
        auto pn = obj->getProperty ("projectName").toString();
        auto bb = obj->getProperty ("backendBase").toString();
        auto tk = obj->getProperty ("authToken").toString();
        if (pn.isNotEmpty()) setProjectName (pn);
        if (bb.isNotEmpty()) setBackendBase (bb);
        if (tk.isNotEmpty()) setAuthToken (tk);
        return;
    }
    // Backwards compat: very old saves used MemoryOutputStream::writeString.
    juce::MemoryInputStream stream (data, (size_t) size, false);
    auto name = stream.readString();
    if (name.isNotEmpty()) setProjectName (name);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new EarshotAudioProcessor();
}
