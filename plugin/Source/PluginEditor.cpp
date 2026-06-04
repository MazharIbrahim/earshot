#include "PluginEditor.h"

using namespace EarshotBrand;

static juce::Font monoFont (float height, juce::Font::FontStyleFlags style = juce::Font::plain)
{
    return juce::Font (juce::Font::getDefaultMonospacedFontName(), height, style);
}

EarshotAudioProcessorEditor::EarshotAudioProcessorEditor (EarshotAudioProcessor& p)
    : AudioProcessorEditor (&p), processorRef (p)
{
    setLookAndFeel (&lnf);
    setSize (320, 360);

    wordmark.setText ("EARSHOT", juce::dontSendNotification);
    wordmark.setFont (monoFont (13.0f, juce::Font::bold));
    wordmark.setColour (juce::Label::textColourId, textMuted);
    wordmark.setJustificationType (juce::Justification::centredLeft);
    addAndMakeVisible (wordmark);

    projectLabel.setText (processorRef.getProjectName(), juce::dontSendNotification);
    projectLabel.setFont (monoFont (18.0f, juce::Font::bold));
    projectLabel.setColour (juce::Label::textColourId, text);
    projectLabel.setEditable (false, true, false);
    projectLabel.onTextChange = [this] { processorRef.setProjectName (projectLabel.getText()); };
    addAndMakeVisible (projectLabel);

    liveLabel.setText ("offline", juce::dontSendNotification);
    liveLabel.setFont (monoFont (12.0f));
    liveLabel.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (liveLabel);

    snapshotButton.onClick = [] { /* TODO: trigger snapshot capture */ };
    addAndMakeVisible (snapshotButton);

    qrButton.onClick = [] { /* TODO: show QR modal with mobile URL */ };
    addAndMakeVisible (qrButton);

    takesHeader.setText ("recent takes", juce::dontSendNotification);
    takesHeader.setFont (monoFont (11.0f));
    takesHeader.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (takesHeader);

    takesPlaceholder.setText ("no takes yet — hit play and snapshot.",
                              juce::dontSendNotification);
    takesPlaceholder.setFont (monoFont (12.0f));
    takesPlaceholder.setColour (juce::Label::textColourId, textMuted);
    takesPlaceholder.setJustificationType (juce::Justification::topLeft);
    addAndMakeVisible (takesPlaceholder);

    accountChip.setText ("not signed in · tap to link", juce::dontSendNotification);
    accountChip.setFont (monoFont (11.0f));
    accountChip.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (accountChip);

    startTimerHz (4);
}

EarshotAudioProcessorEditor::~EarshotAudioProcessorEditor()
{
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
    liveLabel.setBounds (topBar.removeFromRight (120));

    r.removeFromTop (8);
    projectLabel.setBounds (r.removeFromTop (28));

    r.removeFromTop (16);
    snapshotButton.setBounds (r.removeFromTop (48));

    r.removeFromTop (24);
    takesHeader.setBounds (r.removeFromTop (16));
    r.removeFromTop (6);
    auto takesArea = r.removeFromTop (120);
    takesPlaceholder.setBounds (takesArea);

    auto bottom = r.removeFromBottom (24);
    accountChip.setBounds (bottom.removeFromLeft (200));
    qrButton.setBounds (bottom.removeFromRight (40));
}

void EarshotAudioProcessorEditor::timerCallback()
{
    if (processorRef.isLive())
    {
        liveLabel.setText ("live · " + juce::String (processorRef.listenerCount())
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
