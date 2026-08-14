<img width="1080" height="2400" alt="Screenshot_2026-08-14-08-55-44-426_com android chrome" src="https://github.com/user-attachments/assets/1e3a7801-eb83-45ff-9368-1d17b00125be" />



https://github.com/user-attachments/assets/dcad2748-968f-44a1-9312-b652a20fd9c9


"The background noise (SQ) heard in the demonstration video is just a placeholder recording (noise.mp3). You can customize it by replacing the file with your own preferred audio recording."


WalkieTalkie Plugin - Tactical Communications System
Overview
WalkieTalkie is a real-time voice communication plugin for HFS (HTTP File Server) that enables push-to-talk (PTT) broadcasting similar to a walkie-talkie. Multiple users can communicate in real-time with low latency, making it ideal for team coordination, remote operations, or any scenario requiring instant voice communication.

Key Features:

Real-time voice broadcasting with PTT

Visual waveform display

Signal strength monitoring

Transmission history with playback

Background noise (squelch) for realistic feel

Configurable audio settings

WebSocket-based real-time signaling

Quick Start
1. Prerequisites
HFS (HTTP File Server) installed and running

A microphone connected to your device

Modern web browser (Chrome, Firefox, Edge, or Safari)

2. Installation
Place the WalkieTalkie plugin folder in your HFS plugins directory

Restart HFS or reload plugins

The plugin will appear in your HFS interface

3. First Use
Click the Comms button in the HFS menu bar (or press the hotkey)

Toggle the Online switch to enable the connection

Click PTT (Push-to-Talk) or hold the Space bar to transmit

Release to stop transmitting

Your transmission will be saved in the Comm Log for later playback

Configuration Settings
Access these settings in HFS Plugin Configuration:

Setting	Description	Default
Signal Port	Port for WebSocket signaling connections	8123
Debug Mode	Enable diagnostic logging	false
Max Log Records	Number of transmissions to keep in history	30
Minimum Record Duration	Minimum duration (ms) for a transmission to be saved	2000
Transmission Timeout	Auto-release after inactivity (seconds)	60
Allow Anonymous	Allow unauthenticated users to transmit	false
Signal Buffer Delay	Buffer delay in seconds (2-5 recommended)	2
Mic Gain	Microphone amplification (dB)	6
Transmit Start Tone	Custom start tone file path (optional)	empty
Transmit End Tone	Custom end tone file path (optional)	empty
Background Noise	Custom noise file for squelch (optional)	empty
User Interface Guide
Main Panel
Online Toggle: Enables/disables the connection

SQ Toggle: Enables/disables background noise (squelch)

PTT Button: Click and hold to transmit, release to stop

Waveform Display: Visual representation of audio activity

Signal Bars: Shows connection quality (0-4 bars)

Status Display: Current communication status

Comm Log: History of all transmissions

Keyboard Shortcuts
Space Bar: Hold to transmit (press and hold)

Comms Button: Toggle the panel open/closed

Status Indicators
Online: Connection established

Offline: Connection lost or disabled

TX: You are transmitting

RX: Receiving another user's transmission

Pulse Animation: Active transmission or reception

Workflow
Transmitting
Ensure Online is enabled and signal bars show connection

Click and hold the PTT button (or hold Space bar)

Speak into your microphone

Release to stop transmitting

If transmission duration exceeds Minimum Record Duration, it will be saved

Receiving
When another user transmits, you will hear their voice automatically

The waveform will show the incoming audio

Status will display the transmitter's username

Reviewing History
Scroll down to the Comm Log section

Click any entry to play it back

Click again to stop playback

Unread entries are marked with a dot (●)

Use the ↻ button to refresh the log

Audio Files
The plugin includes default audio files:

start.mp3 - Played when starting transmission

end.mp3 - Played when ending transmission

noise.mp3 - Background noise for squelch

You can replace these with custom files by:

Placing your own files in the plugin directory

Configuring the file paths in plugin settings

Troubleshooting
Connection Issues
"Signal lost" error: Check that the WebSocket server is running

"Signal Port in use": Change the port in settings or stop the conflicting service

Cannot connect: Verify your firewall allows port 8123

Microphone Issues
No audio: Check browser microphone permissions

Low volume: Increase Mic Gain setting (0-30dB)

Distortion: Reduce Mic Gain setting

Transmission Issues
Transmissions not saving: Ensure duration exceeds Minimum Record Duration (2000ms default)

No one hears me: Confirm Online toggle is enabled and signal bars show connection

⚠️ Important: WebSocket Server
This plugin requires a WebSocket server running on port 8123 to enable real-time communication.

Option 1: Using the Provided Binary (Recommended)
Run ws_server_pure15.exe in the background on your HFS server. This lightweight server handles all WebSocket signaling.

Option 2: Regenerate the Server (For Maximum Security)
If you don't trust the pre-compiled EXE, you can regenerate it yourself:

Locate ws_server_pure.py and pure.bat in the plugin directory

Run the batch file or manually execute:

text
py - pure.bat
or

text
python ws_server_pure.py
This will generate a fresh ws_server_pure15.exe from the source code

Security Note: The WebSocket server runs locally on your HFS server and only accepts connections from localhost. All voice data is transmitted through HFS's existing HTTP infrastructure.

File Storage
Audio Files Location
History recordings: [HFS_Data]/storage/walkie_audio/

Live session files: [HFS_Data]/storage/walkie_live/

History database: [HFS_Data]/storage/walkie_history.json

File Naming
History files are named with timestamps:

text
MM-DD-HH-MM-SS-ms.ext
Where ext is webm or wav depending on browser support.

Technical Specifications
Protocol: WebSocket for signaling, HTTP for audio transfer

Audio Codec: Opus (via WebM container)

WebSocket Port: 8123 (configurable)

Buffer Delay: 2 seconds (configurable)

Max History: 30 records (configurable)

Minimum Record Duration: 2000ms (configurable)

⚠️ Important Limitations & Disclaimer
⚠️ CRITICAL NOTICE: This is a TOY / DEMONSTRATION plugin, NOT a professional communication tool!

Please be aware of the following critical limitations:

Microphone Access & HTTPS Restriction
Most modern browsers and devices block microphone access on HTTP (non-HTTPS) connections due to security policies. This means:

❌ This plugin will NOT work on public internet (HTTPS required)

❌ Mobile devices (Android/iOS) typically cannot access the microphone over local HTTP

❌ This is a significant limitation that affects almost all users

In practice, this means:

✅ Works on localhost (127.0.0.1) or LAN with HTTP (desktop browsers only)

❌ Does NOT work on mobile browsers over local HTTP (due to browser restrictions)

❌ Does NOT work on any HTTPS-secured public server (unless you have a valid SSL certificate and configure it properly)

What This Plugin IS:
✅ A fun "toy" for demonstration purposes

✅ A cool showcase for LAN communication experiments

✅ A learning tool for WebSocket and WebRTC concepts

✅ A decorative addition to your HFS server

What This Plugin IS NOT:
❌ NOT a professional communication system

❌ NOT suitable for emergency or life-safety situations

❌ NOT a replacement for proper walkie-talkies or radio systems

❌ NOT a reliable tool for critical communications

Mobile Device Support
If you can resolve the HTTPS issue (by setting up a valid SSL certificate on your local network), this plugin can work on mobile devices. The user experience is actually quite good!

However, I have not yet found a practical solution for enabling microphone access on mobile devices within a local LAN environment over HTTP. For now, this remains a desktop-only toy.

Bottom Line
Please treat this as a "for fun" project only. It's great for:

Impressing your friends with a custom walkie-talkie UI

Learning about real-time audio processing

Experimenting with WebSocket communications

Adding a cool feature to your HFS server

DO NOT RELY ON THIS PLUGIN FOR ANYTHING IMPORTANT, EMERGENCY-RELATED, OR PROFESSIONAL.

Notes
All voice data is stored locally on the HFS server

History playback works for all users with access

Live transmissions are not saved unless they meet the minimum duration

The WebSocket server only communicates with localhost for security
