#pragma once

#include <JuceHeader.h>
#include <atomic>

// Polls the backend's /healthz endpoint to learn the public Cloudflare
// tunnel URL. The plugin shows this URL so a phone can open it from
// anywhere on the internet.
class HealthPoller : public juce::Thread
{
public:
    HealthPoller();
    ~HealthPoller() override;

    void start();
    void stop();

    void setBackendBase (const juce::URL& url) { backendBase = url; }

    juce::String getPublicUrl() const;

    std::function<void()> onUrlChanged;

private:
    void run() override;

    juce::URL backendBase { "http://localhost:8787" };

    juce::CriticalSection urlLock;
    juce::String publicUrl;

    JUCE_DECLARE_NON_COPYABLE (HealthPoller)
};
