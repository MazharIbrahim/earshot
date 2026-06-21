#pragma once

#include <JuceHeader.h>
#include <atomic>

// Drives the plugin's device-link sign-in:
//   1. POST /auth/device-code → get { deviceId, code, redeemUrl }
//   2. Render a QR over the editor pointing at <base>/link?code=NNNNNN
//   3. Poll GET /auth/device-poll?deviceId=… every 2s
//   4. On 200 with token → fire onLinked(token); on 410 → onExpired().
//
// All HTTP runs on a juce::Thread so the editor stays responsive.
class SignInFlow : public juce::Thread
{
public:
    SignInFlow();
    ~SignInFlow() override;

    void start (const juce::URL& backendBase);
    void cancel();

    juce::String getCode() const;
    juce::String getRedeemUrl() const; // <backend>/link?code=XXXXXX

    std::function<void(const juce::String& token)> onLinked;
    std::function<void()> onExpired;
    std::function<void(const juce::String& msg)> onError;

private:
    void run() override;
    bool requestCode();
    int  pollOnce (juce::String& outToken);

    juce::URL backendBase;
    juce::String deviceId;

    juce::CriticalSection codeLock;
    juce::String code;
    juce::String redeemUrl;

    std::atomic<bool> cancelRequested { false };

    JUCE_DECLARE_NON_COPYABLE (SignInFlow)
};
