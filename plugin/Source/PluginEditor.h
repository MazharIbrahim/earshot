#pragma once

#include <JuceHeader.h>
#include "PluginProcessor.h"
#include "BrandLookAndFeel.h"
#include "TakeWriter.h"
#include "TakesPoller.h"
#include "SignInFlow.h"

class LevelMeter : public juce::Component
{
public:
    void setLevels (float l, float r) { levelL = l; levelR = r; repaint(); }
    void paint (juce::Graphics&) override;

private:
    float levelL { 0.0f }, levelR { 0.0f };
};

// Lightweight scrolling-free list of cloud takes inside the plugin.
// Each row shows the editable label + duration + a small delete button.
class TakesListComponent : public juce::Component
{
public:
    void setTakes (std::vector<TakesPoller::CloudTake> next)
    {
        takes = std::move (next);
        repaint();
    }

    // Returns the id at the given local y, or empty if no row hit.
    juce::String idAtRow (int row) const
    {
        if (row < 0 || row >= (int) takes.size()) return {};
        return takes[(size_t) row].id;
    }

    // Mouse: rows are 24px tall starting at 0. Delete button on the right.
    void mouseDown (const juce::MouseEvent& e) override;
    void paint (juce::Graphics&) override;

    std::function<void(const juce::String&)> onDelete;
    static constexpr int rowHeight = 26;
    static constexpr int deleteButtonWidth = 28;

private:
    std::vector<TakesPoller::CloudTake> takes;
};

// Full-overlay modal showing a QR code + URL that the user scans with
// their phone. Click anywhere to dismiss.
class QrOverlay : public juce::Component
{
public:
    QrOverlay() { setAlwaysOnTop (true); }
    void setUrl (const juce::String& url);
    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;

private:
    // True for a brief moment after the user tapped "copy link" so the
    // overlay can flash a confirmation before dismissing.
    bool justCopied { false };
    juce::String urlText;
    // 1 byte per module (0 or 1). Square grid.
    std::vector<uint8_t> qr;
    int qrSize { 0 };
};

class EarshotAudioProcessorEditor : public juce::AudioProcessorEditor,
                                    private juce::Timer
{
public:
    explicit EarshotAudioProcessorEditor (EarshotAudioProcessor&);
    ~EarshotAudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void refreshTakes();
    void updateRecButton();
    void refreshUploadStatus();
    void refreshPublicUrl();
    void showQrFor (const juce::String& url);

    EarshotAudioProcessor& processorRef;
    BrandLookAndFeel lnf;

    juce::Label  wordmark;
    juce::Label  userChip;
    juce::Label  projectLabel;
    juce::Label  statusLabel;
    LevelMeter   meter;
    juce::TextButton recButton  { "record" };
    juce::TextButton openPhoneButton { "sign in" };
    SignInFlow signInFlow;
    juce::Label  takesHeader;
    TakesListComponent takesList;
    juce::Label  urlPrompt;
    juce::Label  urlValue;
    juce::TextButton copyButton { "copy" };
    QrOverlay    qrOverlay;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessorEditor)
};
