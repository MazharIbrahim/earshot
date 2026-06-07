#include "PluginEditor.h"

using namespace EarshotBrand;

static juce::Font monoFont (float height, juce::Font::FontStyleFlags style = juce::Font::plain)
{
    return juce::Font (juce::Font::getDefaultMonospacedFontName(), height, style);
}

static juce::String formatRelative (juce::Time t)
{
    const auto diffMs = juce::Time::getCurrentTime().toMilliseconds() - t.toMilliseconds();
    const auto diffSec = diffMs / 1000;
    if (diffSec < 60)  return juce::String (diffSec) + "s ago";
    if (diffSec < 3600) return juce::String (diffSec / 60) + "m ago";
    if (diffSec < 86400) return juce::String (diffSec / 3600) + "h ago";
    return juce::String (diffSec / 86400) + "d ago";
}

static juce::String formatDuration (double sec)
{
    const int s = (int) sec;
    return juce::String (s / 60) + ":" + juce::String (s % 60).paddedLeft ('0', 2);
}

EarshotAudioProcessorEditor::EarshotAudioProcessorEditor (EarshotAudioProcessor& p)
    : AudioProcessorEditor (&p), processorRef (p)
{
    setLookAndFeel (&lnf);
    setSize (320, 380);

    wordmark.setText ("EARSHOT", juce::dontSendNotification);
    wordmark.setFont (monoFont (13.0f, juce::Font::bold));
    wordmark.setColour (juce::Label::textColourId, textMuted);
    wordmark.setJustificationType (juce::Justification::centredLeft);
    addAndMakeVisible (wordmark);

    projectLabel.setText (processorRef.getProjectName(), juce::dontSendNotification);
    projectLabel.setFont (monoFont (18.0f, juce::Font::bold));
    projectLabel.setColour (juce::Label::textColourId, text);
    projectLabel.setEditable (false, true, false);
    projectLabel.onTextChange = [this]
    {
        processorRef.setProjectName (projectLabel.getText());
    };
    addAndMakeVisible (projectLabel);

    liveLabel.setText ("offline", juce::dontSendNotification);
    liveLabel.setFont (monoFont (12.0f));
    liveLabel.setColour (juce::Label::textColourId, textMuted);
    liveLabel.setJustificationType (juce::Justification::centredRight);
    addAndMakeVisible (liveLabel);

    snapshotButton.onClick = [this]
    {
        // Open takes folder for now. Real "force snapshot" will arm the writer
        // independent of the host transport.
        TakeWriter::takesRoot().revealToUser();
    };
    addAndMakeVisible (snapshotButton);

    qrButton.onClick = [] { /* TODO: show QR modal with mobile URL */ };
    addAndMakeVisible (qrButton);

    takesHeader.setText ("recent takes", juce::dontSendNotification);
    takesHeader.setFont (monoFont (11.0f));
    takesHeader.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (takesHeader);

    takesBody.setFont (monoFont (12.0f));
    takesBody.setColour (juce::Label::textColourId, textMuted);
    takesBody.setJustificationType (juce::Justification::topLeft);
    addAndMakeVisible (takesBody);

    accountChip.setText (juce::String::fromUTF8 ("not signed in · tap to link"),
                         juce::dontSendNotification);
    accountChip.setFont (monoFont (11.0f));
    accountChip.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (accountChip);

    processorRef.getTakeWriter().onTakesChanged = [this]
    {
        juce::MessageManager::callAsync ([sp = juce::Component::SafePointer<EarshotAudioProcessorEditor> (this)]
        {
            if (sp != nullptr) sp->refreshTakes();
        });
    };

    refreshTakes();
    startTimerHz (4);
}

EarshotAudioProcessorEditor::~EarshotAudioProcessorEditor()
{
    processorRef.getTakeWriter().onTakesChanged = nullptr;
    setLookAndFeel (nullptr);
}

void EarshotAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (background);

    auto sep = getLocalBounds().reduced (16, 0).withHeight (1).withY (180);
    g.setColour (stroke);
    g.fillRect (sep);
}

void EarshotAudioProcessorEditor::resized()
{
    auto r = getLocalBounds().reduced (16);

    auto topBar = r.removeFromTop (24);
    wordmark.setBounds (topBar.removeFromLeft (90));
    liveLabel.setBounds (topBar.removeFromRight (160));

    r.removeFromTop (8);
    projectLabel.setBounds (r.removeFromTop (28));

    r.removeFromTop (16);
    snapshotButton.setBounds (r.removeFromTop (48));

    r.removeFromTop (24);
    takesHeader.setBounds (r.removeFromTop (16));
    r.removeFromTop (6);
    auto takesArea = r.removeFromTop (140);
    takesBody.setBounds (takesArea);

    auto bottom = r.removeFromBottom (24);
    accountChip.setBounds (bottom.removeFromLeft (220));
    qrButton.setBounds (bottom.removeFromRight (40));
}

void EarshotAudioProcessorEditor::timerCallback()
{
    if (processorRef.isCapturing())
    {
        liveLabel.setText (juce::String::fromUTF8 ("recording · take in progress"),
                           juce::dontSendNotification);
        liveLabel.setColour (juce::Label::textColourId, accent);
    }
    else if (processorRef.isLive())
    {
        liveLabel.setText (juce::String::fromUTF8 ("live · ")
                           + juce::String (processorRef.listenerCount())
                           + (processorRef.listenerCount() == 1 ? " listener" : " listeners"),
                           juce::dontSendNotification);
        liveLabel.setColour (juce::Label::textColourId, accent);
    }
    else
    {
        liveLabel.setText ("offline", juce::dontSendNotification);
        liveLabel.setColour (juce::Label::textColourId, textMuted);
    }
}

void EarshotAudioProcessorEditor::refreshTakes()
{
    auto t = processorRef.getTakeWriter().snapshotTakes();
    takesBody.setText (renderTakesText (t), juce::dontSendNotification);
    takesBody.setColour (juce::Label::textColourId,
                         t.empty() ? textMuted : text);
}

juce::String EarshotAudioProcessorEditor::renderTakesText (const std::vector<TakeRecord>& list) const
{
    if (list.empty())
        return juce::String::fromUTF8 ("no takes yet — hit play in your DAW.");

    juce::String out;
    int shown = 0;
    for (auto& t : list)
    {
        if (shown >= 5) break;
        out << t.label << "  "
            << formatDuration (t.durationSec)
            << juce::String::fromUTF8 ("  ·  ")
            << formatRelative (t.createdAt)
            << "\n";
        ++shown;
    }
    return out.trim();
}
