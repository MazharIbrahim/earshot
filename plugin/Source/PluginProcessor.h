#pragma once

#include <JuceHeader.h>
#include "CaptureBuffer.h"
#include "TakeWriter.h"
#include "Uploader.h"
#include "HealthPoller.h"
#include "TakesPoller.h"

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

    // Backend base URL — production by default, override-able from the
    // settings modal for dev or self-hosting.
    juce::String getBackendBase() const { return backendBase; }
    void setBackendBase (const juce::String& url);

    // Long-lived JWT obtained via the device-link flow. Empty when
    // signed out. Sent as Authorization: Bearer on every API call.
    juce::String getAuthToken() const { return authToken; }
    void setAuthToken (const juce::String& tok);

    // Email parsed out of the JWT payload — used for the username chip.
    juce::String getUserEmail() const { return userEmail; }

    // Arm-and-wait recording: when armed, the audio thread starts a take
    // the next time the host transport plays, and ends it when transport stops.
    void setArmed (bool shouldArm) { armRequested.store (shouldArm); }
    bool isArmed() const     { return armRequested.load(); }
    bool isRecording() const { return capturing.load(); }
    bool isWaitingForPlay() const { return armRequested.load() && ! capturing.load(); }

    // Diagnostic: total frames passed through the ring buffer for this take.
    juce::int64 getFramesCapturedThisTake() const { return framesCapturedThisTake.load(); }

    // Peak meter — read by the editor on a timer. Decays automatically.
    float getPeakL() const { return peakL.load(); }
    float getPeakR() const { return peakR.load(); }

    TakeWriter&   getTakeWriter()   { return takeWriter; }
    Uploader&     getUploader()     { return uploader; }
    HealthPoller& getHealthPoller() { return healthPoller; }
    TakesPoller&  getTakesPoller()  { return takesPoller; }

    // Future fields, surfaced for the editor.
    bool isLive() const { return liveActive.load(); }
    int  listenerCount() const { return listeners.load(); }

private:
    juce::String projectName { "Untitled" };
    juce::String backendBase { "https://app.earshot.cc" };
    juce::String authToken;
    juce::String userEmail;
    std::atomic<bool> liveActive { false };
    std::atomic<int>  listeners  { 0 };

    CaptureBuffer captureBuffer;
    TakeWriter    takeWriter;
    Uploader      uploader;
    HealthPoller  healthPoller;
    TakesPoller   takesPoller;
    std::atomic<bool> capturing    { false };
    std::atomic<bool> armRequested { false };
    bool prevCapturing { false };

    // Atomic peak levels updated each processBlock.
    std::atomic<float> peakL { 0.0f };
    std::atomic<float> peakR { 0.0f };
    float peakDecay { 0.85f };

    std::atomic<juce::int64> framesCapturedThisTake { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessor)
};
