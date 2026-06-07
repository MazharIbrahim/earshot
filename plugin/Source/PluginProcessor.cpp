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

    // Detect host transport state. Some hosts don't supply a playhead;
    // when missing, treat as "always playing" so we still capture audio
    // (useful for testing with a tone generator above us).
    bool hostPlaying = true;
    if (auto* ph = getPlayHead())
    {
        if (auto pos = ph->getPosition())
            hostPlaying = pos->getIsPlaying();
    }

    // Edge transitions arm/disarm the writer.
    if (hostPlaying && ! prevPlaying)
    {
        capturing.store (true,  std::memory_order_release);
        takeWriter.arm();
    }
    else if (! hostPlaying && prevPlaying)
    {
        capturing.store (false, std::memory_order_release);
        takeWriter.disarm();
    }
    prevPlaying = hostPlaying;

    // Push into ring buffer while capturing. We push a stereo pair; if the
    // bus is mono we duplicate it across both channels.
    if (hostPlaying)
    {
        const int n = buffer.getNumSamples();
        const float* l = buffer.getReadPointer (0);
        const float* r = buffer.getNumChannels() > 1 ? buffer.getReadPointer (1) : l;
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
