#include "HealthPoller.h"

HealthPoller::HealthPoller() : juce::Thread ("Earshot Health Poller") {}

HealthPoller::~HealthPoller() { stop(); }

void HealthPoller::start()
{
    if (! isThreadRunning())
        startThread (juce::Thread::Priority::background);
}

void HealthPoller::stop()
{
    signalThreadShouldExit();
    notify();
    stopThread (2000);
}

juce::String HealthPoller::getPublicUrl() const
{
    const juce::ScopedLock lock (urlLock);
    return publicUrl;
}

void HealthPoller::run()
{
    while (! threadShouldExit())
    {
        auto url = backendBase.getChildURL ("healthz");
        int statusCode = 0;
        juce::StringPairArray headers;

        auto stream = url.createInputStream (
            juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                .withConnectionTimeoutMs (3000)
                .withResponseHeaders (&headers)
                .withStatusCode (&statusCode));

        if (stream != nullptr && statusCode == 200)
        {
            auto body = stream->readEntireStreamAsString();
            auto v = juce::JSON::parse (body);
            if (auto* obj = v.getDynamicObject())
            {
                auto newUrl = obj->getProperty ("publicUrl").toString();
                bool changed = false;
                {
                    const juce::ScopedLock lock (urlLock);
                    if (newUrl != publicUrl)
                    {
                        publicUrl = newUrl;
                        changed = true;
                    }
                }
                if (changed && onUrlChanged)
                    juce::MessageManager::callAsync ([cb = onUrlChanged] { if (cb) cb(); });
            }
        }

        wait (5000);
    }
}
