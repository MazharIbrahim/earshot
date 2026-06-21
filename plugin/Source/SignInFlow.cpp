#include "SignInFlow.h"

SignInFlow::SignInFlow() : juce::Thread ("Earshot SignIn") {}

SignInFlow::~SignInFlow() { cancel(); stopThread (2000); }

void SignInFlow::start (const juce::URL& base)
{
    cancel();
    stopThread (2000);
    cancelRequested = false;
    backendBase = base;
    {
        const juce::ScopedLock lock (codeLock);
        code.clear();
        redeemUrl.clear();
    }
    startThread (juce::Thread::Priority::background);
}

void SignInFlow::cancel()
{
    cancelRequested = true;
    notify();
}

juce::String SignInFlow::getCode() const
{
    const juce::ScopedLock lock (codeLock);
    return code;
}

juce::String SignInFlow::getRedeemUrl() const
{
    const juce::ScopedLock lock (codeLock);
    return redeemUrl;
}

bool SignInFlow::requestCode()
{
    auto url = backendBase.getChildURL ("auth").getChildURL ("device-code");
    int status = 0;
    juce::StringPairArray headers;

    auto stream = url.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
            .withConnectionTimeoutMs (10000)
            .withResponseHeaders (&headers)
            .withStatusCode (&status));

    if (stream == nullptr || status < 200 || status >= 300) return false;
    auto body = stream->readEntireStreamAsString();
    auto v = juce::JSON::parse (body);
    auto* obj = v.getDynamicObject();
    if (! obj) return false;

    deviceId = obj->getProperty ("deviceId").toString();
    auto c   = obj->getProperty ("code").toString();
    auto r   = obj->getProperty ("redeemUrl").toString();
    if (deviceId.isEmpty() || c.isEmpty()) return false;

    {
        const juce::ScopedLock lock (codeLock);
        code = c;
        redeemUrl = (r.isNotEmpty() ? r : (backendBase.toString (false) + "/link"))
                     + "?code=" + c;
    }
    return true;
}

int SignInFlow::pollOnce (juce::String& outToken)
{
    auto url = backendBase.getChildURL ("auth").getChildURL ("device-poll")
                .withParameter ("deviceId", deviceId);
    int status = 0;
    juce::StringPairArray headers;

    auto stream = url.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs (5000)
            .withResponseHeaders (&headers)
            .withStatusCode (&status));

    if (stream == nullptr) return -1;
    auto body = stream->readEntireStreamAsString();
    if (status == 200)
    {
        auto v = juce::JSON::parse (body);
        if (auto* obj = v.getDynamicObject())
            outToken = obj->getProperty ("token").toString();
    }
    return status;
}

void SignInFlow::run()
{
    if (! requestCode())
    {
        juce::MessageManager::callAsync ([cb = onError] { if (cb) cb ("could not reach backend"); });
        return;
    }

    // Up to 5 min of polling (150 * 2s).
    for (int i = 0; i < 150 && ! cancelRequested && ! threadShouldExit(); ++i)
    {
        juce::String token;
        const int s = pollOnce (token);
        if (s == 200 && token.isNotEmpty())
        {
            juce::MessageManager::callAsync ([cb = onLinked, t = token] { if (cb) cb (t); });
            return;
        }
        if (s == 410)
        {
            juce::MessageManager::callAsync ([cb = onExpired] { if (cb) cb(); });
            return;
        }
        // 202 = pending, 404 = device id flushed, anything else = transient. Sleep + retry.
        for (int j = 0; j < 20 && ! cancelRequested && ! threadShouldExit(); ++j)
            wait (100);
    }
}
