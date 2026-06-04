#pragma once

#include <JuceHeader.h>

class EarshotAudioProcessor : public juce::AudioProcessor
{
public:
    EarshotAudioProcessor();
    ~EarshotAudioProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;

    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Earshot"; }

    bool acceptsMidi() const override  { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock&) override {}
    void setStateInformation (const void*, int) override {}

    // Project state — surfaced to the editor.
    juce::String getProjectName() const { return projectName; }
    void setProjectName (const juce::String& name) { projectName = name; }

    bool isLive() const { return liveActive; }
    int  listenerCount() const { return listeners; }

private:
    juce::String projectName { "Untitled" };
    std::atomic<bool> liveActive { false };
    std::atomic<int>  listeners  { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessor)
};
