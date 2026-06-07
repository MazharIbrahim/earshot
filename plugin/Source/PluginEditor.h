#pragma once

#include <JuceHeader.h>
#include "PluginProcessor.h"
#include "BrandLookAndFeel.h"
#include "TakeWriter.h"

class LevelMeter : public juce::Component
{
public:
    void setLevels (float l, float r) { levelL = l; levelR = r; repaint(); }
    void paint (juce::Graphics&) override;

private:
    float levelL { 0.0f }, levelR { 0.0f };
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
    juce::String renderTakesText (const std::vector<TakeRecord>&) const;
    void updateRecButton();
    void refreshUploadStatus();
    void refreshPublicUrl();

    EarshotAudioProcessor& processorRef;
    BrandLookAndFeel lnf;

    juce::Label  wordmark;
    juce::Label  projectLabel;
    juce::Label  statusLabel;
    LevelMeter   meter;
    juce::TextButton recButton  { "record" };
    juce::TextButton openFolderButton { "show in finder" };
    juce::Label  takesHeader;
    juce::Label  takesBody;
    // Footer: public URL for the mobile preview, plus a "copy" button.
    juce::Label      urlPrompt;
    juce::Label      urlValue;
    juce::TextButton copyButton { "copy" };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EarshotAudioProcessorEditor)
};
