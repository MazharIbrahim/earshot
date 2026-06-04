#include "PluginProcessor.h"
#include "PluginEditor.h"

EarshotAudioProcessor::EarshotAudioProcessor()
    : AudioProcessor (BusesProperties()
        .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
        .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
}

void EarshotAudioProcessor::prepareToPlay (double, int) {}

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
    // Pass-through. Audio tap, Opus encoding, and streaming come next.
}

juce::AudioProcessorEditor* EarshotAudioProcessor::createEditor()
{
    return new EarshotAudioProcessorEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new EarshotAudioProcessor();
}
