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

// Matches backend slug(): lowercase, non-alphanumeric -> '-', collapse runs,
// trim leading/trailing dashes. Identical output to the JS implementation so
// the project URL the plugin opens lands on the same Project page the PWA
// would have routed to.
static juce::String slugify (const juce::String& s)
{
    juce::String out;
    bool lastWasDash = true; // suppress leading dash
    for (auto cp : s.toLowerCase())
    {
        bool alnum = (cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9');
        if (alnum) { out += juce::String::charToString (cp); lastWasDash = false; }
        else if (! lastWasDash) { out += '-'; lastWasDash = true; }
    }
    while (out.endsWithChar ('-')) out = out.dropLastCharacters (1);
    return out.isEmpty() ? juce::String ("untitled") : out;
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
    setSize (360, 470);

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

    openBrowserButton.onClick = [this]
    {
        auto base = processorRef.getHealthPoller().getPublicUrl();
        if (base.isEmpty()) return;
        auto slug = slugify (processorRef.getProjectName());
        juce::URL deepLink (base + "/p/" + slug);
        deepLink.launchInDefaultBrowser();
    };
    addAndMakeVisible (openBrowserButton);

    urlPrompt.setText ("mobile preview", juce::dontSendNotification);
    urlPrompt.setFont (monoFont (11.0f));
    urlPrompt.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (urlPrompt);

    urlValue.setText ("connecting…", juce::dontSendNotification);
    urlValue.setFont (monoFont (11.0f));
    urlValue.setColour (juce::Label::textColourId, accent);
    addAndMakeVisible (urlValue);

    copyButton.onClick = [this]
    {
        auto url = processorRef.getHealthPoller().getPublicUrl();
        if (url.isNotEmpty())
            juce::SystemClipboard::copyTextToClipboard (url);
    };
    addAndMakeVisible (copyButton);

    takesHeader.setText ("recent takes", juce::dontSendNotification);
    takesHeader.setFont (monoFont (11.0f));
    takesHeader.setColour (juce::Label::textColourId, textMuted);
    addAndMakeVisible (takesHeader);

    takesBody.setFont (monoFont (12.0f));
    takesBody.setColour (juce::Label::textColourId, textMuted);
    takesBody.setJustificationType (juce::Justification::topLeft);
    addAndMakeVisible (takesBody);

    processorRef.getTakeWriter().onTakesChanged = [this]
    {
        juce::MessageManager::callAsync ([sp = juce::Component::SafePointer<EarshotAudioProcessorEditor> (this)]
        {
            if (sp != nullptr) sp->refreshTakes();
        });
    };

    processorRef.getUploader().onStateChanged = [this]
    {
        juce::MessageManager::callAsync ([sp = juce::Component::SafePointer<EarshotAudioProcessorEditor> (this)]
        {
            if (sp != nullptr) sp->refreshUploadStatus();
        });
    };

    processorRef.getHealthPoller().onUrlChanged = [this]
    {
        juce::MessageManager::callAsync ([sp = juce::Component::SafePointer<EarshotAudioProcessorEditor> (this)]
        {
            if (sp != nullptr) sp->refreshPublicUrl();
        });
    };

    refreshTakes();
    updateRecButton();
    refreshUploadStatus();
    refreshPublicUrl();
    startTimerHz (24); // smooth meter
}

EarshotAudioProcessorEditor::~EarshotAudioProcessorEditor()
{
    processorRef.getTakeWriter().onTakesChanged = nullptr;
    processorRef.getUploader().onStateChanged   = nullptr;
    processorRef.getHealthPoller().onUrlChanged = nullptr;
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
    auto actionRow = r.removeFromTop (28);
    auto half = actionRow.getWidth() / 2 - 4;
    openBrowserButton.setBounds (actionRow.removeFromLeft (half));
    actionRow.removeFromLeft (8);
    openFolderButton.setBounds (actionRow.removeFromLeft (half));

    r.removeFromTop (20);
    takesHeader.setBounds (r.removeFromTop (16));
    r.removeFromTop (6);
    auto takesArea = r.removeFromTop (140);
    takesBody.setBounds (takesArea);

    // Footer: two-line block — prompt label, then URL row with copy button.
    auto footer = r.removeFromBottom (44);
    urlPrompt.setBounds (footer.removeFromTop (14));
    auto urlRow = footer.removeFromTop (24);
    copyButton.setBounds (urlRow.removeFromRight (56));
    urlRow.removeFromRight (8);
    urlValue.setBounds (urlRow);
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

void EarshotAudioProcessorEditor::refreshPublicUrl()
{
    auto url = processorRef.getHealthPoller().getPublicUrl();
    if (url.isEmpty())
    {
        urlValue.setText (juce::String::fromUTF8 ("connecting…"),
                          juce::dontSendNotification);
        urlValue.setColour (juce::Label::textColourId, textMuted);
        copyButton.setEnabled (false);
        openBrowserButton.setEnabled (false);
    }
    else
    {
        // Strip the scheme for display — the tunnel URL is long, this saves
        // horizontal space without losing what you'd type into a phone browser.
        auto display = url.startsWith ("https://") ? url.substring (8)
                     : url.startsWith ("http://")  ? url.substring (7)
                     : url;
        urlValue.setText (display, juce::dontSendNotification);
        urlValue.setColour (juce::Label::textColourId, accent);
        copyButton.setEnabled (true);
        openBrowserButton.setEnabled (true);
    }
}

void EarshotAudioProcessorEditor::refreshUploadStatus()
{
    auto& u = processorRef.getUploader();
    const int queued = u.getQueueDepth();

    juce::String suffix;
    juce::Colour col = textMuted;

    switch (u.getState())
    {
        case Uploader::State::Idle:
            suffix = queued > 0
                ? juce::String::fromUTF8 (" · queued ") + juce::String (queued)
                : juce::String::fromUTF8 (" · synced");
            break;
        case Uploader::State::Uploading:
            suffix = juce::String::fromUTF8 ("  uploading…");
            if (queued > 1) suffix << " (" << queued << ")";
            col = accent;
            break;
        case Uploader::State::Failed:
            suffix = juce::String::fromUTF8 (" · upload failed — retrying");
            col = juce::Colour (0xffff5a3c);
            break;
    }

    takesHeader.setText (juce::String ("recent takes") + suffix,
                         juce::dontSendNotification);
    takesHeader.setColour (juce::Label::textColourId, col);
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
