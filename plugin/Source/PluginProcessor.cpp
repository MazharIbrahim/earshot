#include "PluginProcessor.h"
#include "PluginEditor.h"

EarshotAudioProcessor::EarshotAudioProcessor()
    : AudioProcessor (BusesProperties()
        .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
        .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      takeWriter (captureBuffer)
{
}

EarshotAudioProcessor::~EarshotAudioProcessor()
{
    takeWriter.stop();
}

void EarshotAudioProcessor::prepareToPlay (double sampleRate, int /*samplesPerBlock*/)
{
    captureBuffer.reset();
    takeWriter.setProjectName (projectName);
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

        // Manual REC: writer is armed only when the user toggles record.
        const bool wantRecord = recordRequested.load (std::memory_order_acquire);
        if (wantRecord && ! prevRecording)
        {
            capturing.store (true, std::memory_order_release);
            takeWriter.arm();
        }
        else if (! wantRecord && prevRecording)
        {
            capturing.store (false, std::memory_order_release);
            takeWriter.disarm();
        }
        prevRecording = wantRecord;

        if (wantRecord)
            captureBuffer.push (l, r, n);
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
