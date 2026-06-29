#include "ProjectsPoller.h"

ProjectsPoller::ProjectsPoller() : juce::Thread ("Earshot Projects Poller") {}
ProjectsPoller::~ProjectsPoller() { stop(); }

void ProjectsPoller::start()
{
    if (! isThreadRunning())
        startThread (juce::Thread::Priority::background);
}

void ProjectsPoller::stop()
{
    signalThreadShouldExit();
    notify();
    stopThread (2000);
}

std::vector<ProjectsPoller::ProjectSummary> ProjectsPoller::getProjects() const
{
    const juce::ScopedLock lock (projectsLock);
    return projects;
}

void ProjectsPoller::run()
{
    while (! threadShouldExit())
    {
        poll();
        wait (30000); // 30 s — projects don't change often
    }
}

void ProjectsPoller::poll()
{
    juce::String token;
    { const juce::ScopedLock lock (tokenLock); token = authToken; }
    if (token.isEmpty()) return; // can't list without auth

    auto url = backendBase.getChildURL ("projects");
    juce::String extra;
    extra << "Authorization: Bearer " << token;

    int statusCode = 0;
    juce::StringPairArray headers;
    auto stream = url.createInputStream (
        juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
            .withConnectionTimeoutMs (5000)
            .withExtraHeaders (extra)
            .withResponseHeaders (&headers)
            .withStatusCode (&statusCode));
    if (stream == nullptr || statusCode != 200) return;

    auto body = stream->readEntireStreamAsString();
    auto v = juce::JSON::parse (body);
    auto* arr = v.getArray();
    if (! arr) return;

    std::vector<ProjectSummary> next;
    next.reserve ((size_t) arr->size());
    for (auto& item : *arr)
    {
        if (auto* obj = item.getDynamicObject())
        {
            ProjectSummary p;
            p.projectId        = obj->getProperty ("projectId").toString();
            p.project          = obj->getProperty ("project").toString();
            p.takes            = (int) obj->getProperty ("takes");
            p.latestCreatedAtMs = (juce::int64) obj->getProperty ("latestCreatedAt");
            next.push_back (std::move (p));
        }
    }

    bool changed = false;
    {
        const juce::ScopedLock lock (projectsLock);
        if (next.size() != projects.size()) changed = true;
        else for (size_t i = 0; i < next.size(); ++i)
            if (next[i].projectId != projects[i].projectId
                || next[i].takes  != projects[i].takes)
            { changed = true; break; }
        if (changed) projects = std::move (next);
    }
    if (changed && onProjectsChanged)
        juce::MessageManager::callAsync ([cb = onProjectsChanged] { if (cb) cb(); });
}
