#pragma once

#include <JuceHeader.h>
#include "CaptureBuffer.h"
#include <atomic>

// Persisted record of a finished take. Displayed in the editor.
struct TakeRecord
{
    juce::String label;
    juce::File   file;
    double       durationSec { 0.0 };
    juce::Time   createdAt;
};

// Background thread that drains CaptureBuffer to a WAV file.
// One "take" per arm/disarm cycle. The audio thread calls arm() / disarm();
// this thread does the actual file I/O.
class TakeWriter : public juce::Thread
{
public:
    explicit TakeWriter (CaptureBuffer& buf);
    ~TakeWriter() override;

    void start (double sampleRate);
    void stop();

    // Called from audio thread on transport change.
    void arm()    noexcept { armed.store (true,  std::memory_order_release); }
    void disarm() noexcept { armed.store (false, std::memory_order_release); }

    // Called from message thread to read latest take list.
    std::vector<TakeRecord> snapshotTakes() const;

    void setProjectName (const juce::String& name);

    std::function<void()> onTakesChanged;

    static juce::File takesRoot();

private:
    void run() override;
    void openNewFile();
    void closeFile();

    CaptureBuffer& buffer;
    std::atomic<bool> armed { false };
    bool fileOpen { false };
    double sampleRate { 48000.0 };
    juce::int64 framesWritten { 0 };

    std::unique_ptr<juce::AudioFormatWriter> writer;
    juce::File currentFile;

    juce::CriticalSection takesLock;
    std::vector<TakeRecord> takes;

    juce::CriticalSection projectNameLock;
    juce::String projectName { "Untitled" };

    JUCE_DECLARE_NON_COPYABLE (TakeWriter)
};
