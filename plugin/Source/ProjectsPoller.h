#pragma once

#include <JuceHeader.h>

// Polls GET /projects so the plugin can show a switcher menu of the
// user's existing projects. Cheap to keep fresh — projects don't change
// often. 30 s poll interval.
class ProjectsPoller : public juce::Thread
{
public:
    struct ProjectSummary
    {
        juce::String projectId; // slug
        juce::String project;   // display name
        int          takes { 0 };
        juce::int64  latestCreatedAtMs { 0 };
    };

    ProjectsPoller();
    ~ProjectsPoller() override;

    void start();
    void stop();

    void setBackendBase (const juce::URL& url) { backendBase = url; notify(); }
    void setAuthToken (const juce::String& tok)
    {
        const juce::ScopedLock lock (tokenLock);
        authToken = tok;
        notify();
    }

    std::vector<ProjectSummary> getProjects() const;

    std::function<void()> onProjectsChanged;

private:
    void run() override;
    void poll();

    juce::URL backendBase { "https://app.earshot.cc" };

    juce::CriticalSection tokenLock;
    juce::String authToken;

    juce::CriticalSection projectsLock;
    std::vector<ProjectSummary> projects;

    JUCE_DECLARE_NON_COPYABLE (ProjectsPoller)
};
