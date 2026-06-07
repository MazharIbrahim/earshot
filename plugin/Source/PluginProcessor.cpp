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
    uploader.start();
    healthPoller.start();
}

EarshotAudioProcessor::~EarshotAudioProcessor()
{
    takeWriter.onTakeSaved = nullptr;
    takeWriter.stop();
    uploader.stop();
    healthPoller.stop();
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

void EarshotAudioProcessor::setProjectName (const juce::String& name)
{
    projectName = name;
    takeWriter.setProjectName (name);
}

void EarshotAudioProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    juce::MemoryOutputStream stream (dest, false);
    stream.writeString (projectName);
}

void EarshotAudioProcessor::setStateInformation (const void* data, int size)
{
    juce::MemoryInputStream stream (data, (size_t) size, false);
    auto name = stream.readString();
    if (name.isNotEmpty())
        setProjectName (name);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new EarshotAudioProcessor();
}
