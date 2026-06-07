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
    if (diffSec < 60)   return juce::String (diffSec) + "s ago";
    if (diffSec < 3600) return juce::String (diffSec / 60) + "m ago";
    if (diffSec < 86400) return juce::String (diffSec / 3600) + "h ago";
    return juce::String (diffSec / 86400) + "d ago";
}

static juce::String formatDuration (double sec)
{
    const int s = (int) sec;
    return juce::String (s / 60) + ":" + juce::String (s % 60).paddedLeft ('0', 2);
}

//==============================================================================
void LevelMeter::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds().toFloat();
    const float gap = 4.0f;
    const float w = (bounds.getWidth() - gap) * 0.5f;

    auto drawBar = [&] (juce::Rectangle<float> r, float level)
    {
        g.setColour (surface);
        g.fillRoundedRectangle (r, 2.0f);

        const float lvl = juce::jlimit (0.0f, 1.0f, level);
        if (lvl > 0.001f)
        {
            auto fill = r.withWidth (r.getWidth() * lvl);
            // Amber below ~0.85, red above for clipping awareness.
            juce::Colour c = lvl > 0.85f ? juce::Colour (0xffff5a3c) : accent;
            g.setColour (c);
            g.fillRoundedRectangle (fill, 2.0f);
        }
    };

    drawBar (bounds.removeFromLeft (w), levelL);
    bounds.removeFromLeft (gap);
    drawBar (bounds, levelR);
}

//==============================================================================
EarshotAudioProcessorEditor::EarshotAudioProcessorEditor (EarshotAudioProcessor& p)
    : AudioProcessorEditor (&p), processorRef (p)
{
    setLookAndFeel (&lnf);
    setSize (340, 430);

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

    statusLabel.setText ("idle", juce::dontSendNotification);
    statusLabel.setFont (monoFont (11.0f));
    statusLabel.setColour (juce::Label::textColourId, textMuted);
    statusLabel.setJustificationType (juce::Justification::centredRight);
    addAndMakeVisible (statusLabel);

    addAndMakeVisible (meter);

    recButton.onClick = [this]
    {
        // One toggle covers all three states:
        //  - idle      → arm (waiting for play)
        //  - armed     → cancel the arm
        //  - recording → force-stop early (transport keeps playing,
        //                we just close the take and disarm)
        processorRef.setArmed (! processorRef.isArmed());
        updateRecButton();
    };
    addAndMakeVisible (recButton);

    openFolderButton.onClick = [] { TakeWriter::takesRoot().revealToUser(); };
    addAndMakeVisible (openFolderButton);

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
    updateRecButton();
    startTimerHz (24); // smooth meter
}

EarshotAudioProcessorEditor::~EarshotAudioProcessorEditor()
{
    processorRef.getTakeWriter().onTakesChanged = nullptr;
    setLookAndFeel (nullptr);
}

void EarshotAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (background);

    auto sep = getLocalBounds().reduced (16, 0).withHeight (1).withY (242);
    g.setColour (stroke);
    g.fillRect (sep);
}

void EarshotAudioProcessorEditor::resized()
{
    auto r = getLocalBounds().reduced (16);

    auto topBar = r.removeFromTop (24);
    wordmark.setBounds (topBar.removeFromLeft (90));
    statusLabel.setBounds (topBar.removeFromRight (180));

    r.removeFromTop (8);
    projectLabel.setBounds (r.removeFromTop (28));

    r.removeFromTop (12);
    meter.setBounds (r.removeFromTop (10));

    r.removeFromTop (16);
    recButton.setBounds (r.removeFromTop (52));

    r.removeFromTop (10);
    openFolderButton.setBounds (r.removeFromTop (28));

    r.removeFromTop (20);
    takesHeader.setBounds (r.removeFromTop (16));
    r.removeFromTop (6);
    auto takesArea = r.removeFromTop (140);
    takesBody.setBounds (takesArea);

    auto bottom = r.removeFromBottom (24);
    accountChip.setBounds (bottom.removeFromLeft (240));
    qrButton.setBounds (bottom.removeFromRight (40));
}

void EarshotAudioProcessorEditor::timerCallback()
{
    meter.setLevels (processorRef.getPeakL(), processorRef.getPeakR());
    updateRecButton(); // transport-driven state changes need a refresh too

    if (processorRef.isRecording())
    {
        const auto frames = processorRef.getFramesCapturedThisTake();
        statusLabel.setText (juce::String::fromUTF8 ("recording · ")
                             + juce::String (frames) + " frames",
                             juce::dontSendNotification);
        statusLabel.setColour (juce::Label::textColourId, accent);
    }
    else if (processorRef.isWaitingForPlay())
    {
        statusLabel.setText (juce::String::fromUTF8 ("armed · waiting for play"),
                             juce::dontSendNotification);
        statusLabel.setColour (juce::Label::textColourId, accent);
    }
    else if (processorRef.isLive())
    {
        statusLabel.setText (juce::String::fromUTF8 ("live · ")
                             + juce::String (processorRef.listenerCount())
                             + (processorRef.listenerCount() == 1 ? " listener" : " listeners"),
                             juce::dontSendNotification);
        statusLabel.setColour (juce::Label::textColourId, accent);
    }
    else
    {
        statusLabel.setText ("idle", juce::dontSendNotification);
        statusLabel.setColour (juce::Label::textColourId, textMuted);
    }
}

void EarshotAudioProcessorEditor::updateRecButton()
{
    if (processorRef.isRecording())
    {
        recButton.setButtonText (juce::String::fromUTF8 ("■  stop"));
        recButton.setToggleState (true, juce::dontSendNotification);
    }
    else if (processorRef.isArmed())
    {
        recButton.setButtonText (juce::String::fromUTF8 ("◌  armed — cancel"));
        recButton.setToggleState (true, juce::dontSendNotification);
    }
    else
    {
        recButton.setButtonText (juce::String::fromUTF8 ("●  record next take"));
        recButton.setToggleState (false, juce::dontSendNotification);
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
        return juce::String::fromUTF8 ("no takes yet — hit record while playing.");

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
