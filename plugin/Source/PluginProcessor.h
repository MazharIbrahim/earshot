#pragma once

#include <JuceHeader.h>
#include "CaptureBuffer.h"
#include "TakeWriter.h"

class EarshotAudioProcessor : public juce::AudioProcessor
{
public:
    EarshotAudioProcessor();
    ~EarshotAudioProcessor() override;

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

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    juce::String getProjectName() const { return projectName; }
    void setProjectName (const juce::String& name);

    bool isCapturing() const { return capturing.load(); }

    TakeWriter& getTakeWriter() { return takeWriter; }

    // Future fields, surfaced for the editor.
    bool isLive() const { return liveActive.load(); }
    int  listenerCount() const { return listeners.load(); }

private:
    juce::String projectName { "Untitled" };
    std::atomic<bool> liveActive { false };
    std::atomic<int>  listeners  { 0 };

    CaptureBuffer captureBuffer;
    TakeWriter    takeWriter;
    std::atomic<bool> capturing { false };
    bool prevPlaying { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessor)
};
