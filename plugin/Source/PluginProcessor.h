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

    // Manual REC toggle from the UI. The audio thread observes this via
    // an atomic flag on the next processBlock and arms/disarms the writer.
    void setRecording (bool shouldRecord) { recordRequested.store (shouldRecord); }
    bool isRecording() const { return capturing.load(); }
    // The user's intent (what they last clicked) — flips immediately on click
    // so the button label can stay in sync without waiting for the audio thread.
    bool wantsToRecord() const { return recordRequested.load(); }

    // Diagnostic: total frames passed through the ring buffer for this take.
    juce::int64 getFramesCapturedThisTake() const { return framesCapturedThisTake.load(); }

    // Peak meter — read by the editor on a timer. Decays automatically.
    float getPeakL() const { return peakL.load(); }
    float getPeakR() const { return peakR.load(); }

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
    std::atomic<bool> capturing       { false };
    std::atomic<bool> recordRequested { false };
    bool prevRecording { false };

    // Atomic peak levels updated each processBlock.
    std::atomic<float> peakL { 0.0f };
    std::atomic<float> peakR { 0.0f };
    float peakDecay { 0.85f };

    std::atomic<juce::int64> framesCapturedThisTake { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessor)
};
