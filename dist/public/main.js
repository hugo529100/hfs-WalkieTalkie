'use strict'

{
    const { useState, useEffect, useRef, useCallback } = HFS.React
    const h = HFS.h
    
    const WS_PORT = 8123
    const myId = Date.now() + '-' + Math.random().toString(36).slice(2)
    const RECORD_INTERVAL = 250
    const END_DELAY = 1000
    
    let globalIsOpen = false
    let ws = null
    let isConnecting = false
    let isManualClose = false
    let reconnectTimeoutId = null
    let isAppClosed = false
    let keepAlive = false
    
    let mediaRecorder = null
    let micStream = null
    let isRecording = false
    let isBroadcasting = false
    let isMine = false
    let currentBroadcaster = null
    let username = 'Guest'
    let globalRenderCallback = null
    let recordedChunks = []
    let endDelayTimer = null
    let statusMessage = 'Standing by - Press PTT to transmit'
    let statusType = 'idle'
    let toastMessage = ''
    let toastIsError = false
    let toastTimer = null
    let liveSessionId = null
    let broadcastStartTime = null
    
    let readHistoryIds = new Set()
    let minRecordDuration = 2000
    
    let isNoiseEnabled = false
    let sqAudioElement = null
    let sqPlaybackStartTime = 0
    let sqTotalDuration = 0
    let sqEnabled = false
    let sqPaused = false
    let sqPlaybackStarted = false
    let sqInitInProgress = false
    let sqForceRefreshTimer = null
    
    let signalBars = 4
    let signalCheckTimer = null
    let isPinging = false
    const PING_INTERVAL = 3000
    
    let liveAudioElement = null
    let liveMediaSource = null
    let liveSourceBuffer = null
    let liveFileUrl = null
    let liveFileSize = 0
    let liveCheckInterval = null
    let livePlaybackStarted = false
    let liveBufferDelay = 2000
    let liveAppendQueue = []
    let isAppending = false
    let liveAudioContext = null
    let liveGainNode = null
    
    let historyAudioElement = null
    let isHistoryPlaying = false
    let historyPlaybackRecord = null
    
    let waveformCanvas = null
    let waveformCtx = null
    let waveformAnimationId = null
    let waveformAnalyser = null
    let waveformSource = null
    let waveformActive = false
    let waveformConnected = false
    let waveformTarget = 'none'
    let waveformGainNode = null
    let waveformCurrentElement = null
    
    let waveformSwitchCooldown = false
    let waveformSwitchTimer = null
    
    const waveformParams = {
        smoothness: 0.35,
        amplitude: 1.2,
        lineWidth: 1.0,
        glowIntensity: 1.0,
        showGrid: true,
        showPeaks: true,
        barCount: 80,
        updateRate: 30
    }
    
    let audioContext = null
    let gainNode = null
    let microphoneGain = 6
    
    let startSound = null
    let endSound = null
    let soundLoading = { start: false, end: false }
    let soundLoaded = { start: false, end: false }
    
    let cachedHistory = []
    let historyLoaded = false
    let isLoadingHistory = false
    let historyLoadTimeout = null
    
    function formatDuration(seconds) {
        if (!seconds || seconds < 0) return '00:00'
        const mins = Math.floor(seconds / 60)
        const secs = Math.floor(seconds % 60)
        return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0')
    }
    
    function getKeepAlive() {
        try { return localStorage.getItem('walkie-keep-alive') === 'true' } catch { return false }
    }
    
    function setKeepAlive(value) {
        keepAlive = value
        try { localStorage.setItem('walkie-keep-alive', String(value)) } catch {}
        if (value) {
            isAppClosed = false
            isManualClose = false
            connect()
        } else {
            disconnectAll()
        }
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function getAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)()
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {})
        }
        return audioContext
    }
    
    function releaseMicrophone() {
        if (mediaRecorder) {
            try {
                if (mediaRecorder.state === 'recording') {
                    mediaRecorder.stop()
                }
            } catch (e) {}
            mediaRecorder = null
        }
        try {
            if (waveformSource) {
                waveformSource.disconnect()
                waveformSource = null
            }
            if (waveformGainNode) {
                waveformGainNode.disconnect()
                waveformGainNode = null
            }
            if (gainNode) {
                gainNode.disconnect()
                gainNode = null
            }
            waveformAnalyser = null
            waveformActive = false
            waveformConnected = false
            waveformCurrentElement = null
        } catch (e) {}
        if (micStream) {
            try {
                const tracks = micStream.getTracks()
                tracks.forEach(function(track) {
                    try {
                        track.stop()
                        track.enabled = false
                    } catch (e) {}
                })
            } catch (e) {}
            micStream = null
        }
        isRecording = false
    }
    
    async function initMicrophone() {
        releaseMicrophone()
        if (!keepAlive) {
            showToast('Enable Online mode first', 2000)
            return false
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast('Microphone not available', 3000, true)
            return false
        }
        try {
            const constraints = {
                audio: { 
                    echoCancellation: true, 
                    noiseSuppression: true, 
                    autoGainControl: true,
                    sampleRate: 48000
                }
            }
            const rawStream = await navigator.mediaDevices.getUserMedia(constraints)
            rawStream.getTracks().forEach(function(track) {
                track.enabled = true
            })
            micStream = rawStream
            return true
        } catch (err) {
            showToast('Microphone not available: ' + err.message, 3000, true)
            return false
        }
    }
    
    function initWaveform(container) {
        if (!container) return
        const canvas = document.createElement('canvas')
        canvas.className = 'walkie-waveform'
        canvas.width = container.clientWidth || 400
        canvas.height = 120
        container.insertBefore(canvas, container.firstChild)
        waveformCanvas = canvas
        waveformCtx = canvas.getContext('2d')
        drawStaticWaveform()
        const resizeObserver = new ResizeObserver(() => {
            if (waveformCanvas && waveformCanvas.parentElement) {
                const rect = waveformCanvas.parentElement.getBoundingClientRect()
                const w = rect.width - 32
                if (w > 0 && w !== waveformCanvas.width) {
                    waveformCanvas.width = w
                    waveformCanvas.height = 120
                    if (!waveformActive) drawStaticWaveform()
                }
            }
        })
        resizeObserver.observe(container)
        startWaveformLoop()
        return canvas
    }
    
    function startWaveformLoop() {
        if (waveformAnimationId) cancelAnimationFrame(waveformAnimationId)
        let lastUpdate = 0
        function loop() {
            if (!waveformCanvas || !waveformCtx) {
                waveformAnimationId = null
                return
            }
            const now = performance.now()
            if (waveformAnalyser && waveformActive) {
                try {
                    const dataArray = new Float32Array(waveformAnalyser.fftSize / 2)
                    waveformAnalyser.getFloatTimeDomainData(dataArray)
                    const displayWidth = waveformCanvas.width || 400
                    const targetLen = Math.min(waveformParams.barCount, Math.floor(displayWidth / 3))
                    const step = Math.max(1, Math.floor(dataArray.length / targetLen))
                    const displayData = new Float32Array(targetLen)
                    for (let i = 0; i < targetLen && i * step < dataArray.length; i++) {
                        let maxVal = 0
                        for (let j = 0; j < step && i * step + j < dataArray.length; j++) {
                            const val = Math.abs(dataArray[i * step + j])
                            if (val > maxVal) maxVal = val
                        }
                        const idx = Math.min(i * step + Math.floor(step/2), dataArray.length - 1)
                        const sign = Math.sign(dataArray[idx]) || 1
                        displayData[i] = sign * Math.min(maxVal * 1.5, 1)
                    }
                    if (now - lastUpdate >= waveformParams.updateRate) {
                        drawWaveform(displayData)
                        lastUpdate = now
                    }
                } catch {
                    drawStaticWaveform()
                }
            } else {
                drawStaticWaveform()
            }
            waveformAnimationId = requestAnimationFrame(loop)
        }
        loop()
    }
    
    function drawStaticWaveform() {
        if (!waveformCtx || !waveformCanvas) return
        const ctx = waveformCtx
        const w = waveformCanvas.width
        const h = waveformCanvas.height
        const mid = h / 2
        ctx.clearRect(0, 0, w, h)
        const bgGrad = ctx.createLinearGradient(0, 0, 0, h)
        bgGrad.addColorStop(0, 'rgba(0,10,0,0.4)')
        bgGrad.addColorStop(0.5, 'rgba(0,20,0,0.6)')
        bgGrad.addColorStop(1, 'rgba(0,10,0,0.4)')
        ctx.fillStyle = bgGrad
        ctx.fillRect(0, 0, w, h)
        if (waveformParams.showGrid) {
            ctx.strokeStyle = 'rgba(50,255,50,0.04)'
            ctx.lineWidth = 0.5
            for (let y = 0; y <= h; y += h / 6) {
                ctx.beginPath()
                ctx.moveTo(0, y)
                ctx.lineTo(w, y)
                ctx.stroke()
            }
            for (let x = 0; x <= w; x += w / 12) {
                ctx.beginPath()
                ctx.moveTo(x, 0)
                ctx.lineTo(x, h)
                ctx.stroke()
            }
        }
        ctx.strokeStyle = 'rgba(50,255,50,0.1)'
        ctx.lineWidth = 0.5
        ctx.setLineDash([4, 6])
        ctx.beginPath()
        ctx.moveTo(0, mid)
        ctx.lineTo(w, mid)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.strokeStyle = 'rgba(50,255,50,0.03)'
        ctx.lineWidth = 0.5
        ctx.beginPath()
        for (let x = 0; x < w; x++) {
            const y = mid + (Math.random() - 0.5) * 2
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.stroke()
        let label = 'STBY'
        let labelColor = 'rgba(50,255,50,0.20)'
        if (waveformTarget === 'history') { 
            label = 'LOG'
            labelColor = 'rgba(50,255,50,0.20)'
        }
        else if (waveformTarget === 'rx') { 
            label = 'RX'
            labelColor = 'rgba(50,255,50,0.20)'
        }
        else if (waveformTarget === 'sq') { 
            label = 'SQ'
            labelColor = 'rgba(50,255,50,0.20)'
        }
        else if (isMine && isRecording) { 
            label = 'TX'
            labelColor = 'rgba(50,255,50,0.20)'
        }
        ctx.fillStyle = labelColor
        ctx.font = '9px monospace'
        ctx.fillText(label, 8, h - 8)
    }
    
    function drawWaveform(data) {
        if (!waveformCtx || !waveformCanvas || !data || data.length < 2) return
        const ctx = waveformCtx
        const w = waveformCanvas.width
        const h = waveformCanvas.height
        const mid = h / 2
        let colorMain = '50,255,50'
        let colorAccent = '100,255,100'
        let alpha = 1.0
        if (isMine && isRecording) {
            colorMain = '255,80,80'
            colorAccent = '255,120,120'
            alpha = 1.0
        }
        ctx.clearRect(0, 0, w, h)
        const bgGrad = ctx.createLinearGradient(0, 0, 0, h)
        bgGrad.addColorStop(0, 'rgba(0,10,0,0.4)')
        bgGrad.addColorStop(0.5, 'rgba(0,20,0,0.6)')
        bgGrad.addColorStop(1, 'rgba(0,10,0,0.4)')
        ctx.fillStyle = bgGrad
        ctx.fillRect(0, 0, w, h)
        if (waveformParams.showGrid) {
            ctx.strokeStyle = `rgba(${colorMain},0.04)`
            ctx.lineWidth = 0.5
            for (let y = 0; y <= h; y += h / 6) {
                ctx.beginPath()
                ctx.moveTo(0, y)
                ctx.lineTo(w, y)
                ctx.stroke()
            }
            for (let x = 0; x <= w; x += w / 12) {
                ctx.beginPath()
                ctx.moveTo(x, 0)
                ctx.lineTo(x, h)
                ctx.stroke()
            }
        }
        ctx.strokeStyle = `rgba(${colorMain},0.1)`
        ctx.lineWidth = 0.5
        ctx.setLineDash([4, 6])
        ctx.beginPath()
        ctx.moveTo(0, mid)
        ctx.lineTo(w, mid)
        ctx.stroke()
        ctx.setLineDash([])
        const step = w / data.length
        const glow = waveformParams.glowIntensity || 1
        const fillGrad = ctx.createLinearGradient(0, 0, 0, h)
        fillGrad.addColorStop(0, `rgba(${colorMain},${0.03 * glow * alpha})`)
        fillGrad.addColorStop(0.5, `rgba(${colorMain},${0.05 * glow * alpha})`)
        fillGrad.addColorStop(1, `rgba(${colorMain},${0.03 * glow * alpha})`)
        ctx.fillStyle = fillGrad
        ctx.beginPath()
        ctx.moveTo(0, mid)
        for (let i = 0; i < data.length; i++) {
            const x = i * step
            const val = Math.min(Math.max(data[i] || 0, -1), 1)
            const y = mid - val * mid * 0.85
            ctx.lineTo(x, y)
        }
        ctx.lineTo(w, mid)
        ctx.closePath()
        ctx.fill()
        const grad = ctx.createLinearGradient(0, 0, w, 0)
        grad.addColorStop(0, `rgba(${colorMain},${0.4 * glow * alpha})`)
        grad.addColorStop(0.3, `rgba(${colorAccent},${0.9 * glow * alpha})`)
        grad.addColorStop(0.5, `rgba(${colorAccent},${1.0 * glow * alpha})`)
        grad.addColorStop(0.7, `rgba(${colorAccent},${0.9 * glow * alpha})`)
        grad.addColorStop(1, `rgba(${colorMain},${0.4 * glow * alpha})`)
        ctx.strokeStyle = grad
        ctx.lineWidth = waveformParams.lineWidth
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        if (glow > 0.3) {
            ctx.shadowColor = `rgba(${colorMain},${0.15 * glow * alpha})`
            ctx.shadowBlur = 10 * glow
        }
        ctx.beginPath()
        for (let i = 0; i < data.length; i++) {
            const x = i * step
            const val = Math.min(Math.max(data[i] || 0, -1), 1)
            const y = mid - val * mid * 0.85
            if (i === 0) {
                ctx.moveTo(x, y)
            } else {
                const prevX = (i - 1) * step
                const prevVal = Math.min(Math.max(data[i - 1] || 0, -1), 1)
                const prevY = mid - prevVal * mid * 0.85
                const cpx = (prevX + x) / 2
                ctx.quadraticCurveTo(cpx, prevY, x, y)
            }
        }
        ctx.stroke()
        ctx.shadowBlur = 0
        if (waveformParams.showPeaks) {
            let maxVal = 0, maxIdx = 0
            for (let i = 0; i < data.length; i++) {
                const absVal = Math.abs(data[i] || 0)
                if (absVal > maxVal) {
                    maxVal = absVal
                    maxIdx = i
                }
            }
            if (maxVal > 0.05) {
                const px = maxIdx * step
                const val = Math.min(Math.max(data[maxIdx] || 0, -1), 1)
                const py = mid - val * mid * 0.85
                ctx.fillStyle = `rgba(${colorAccent},${0.3 * glow * alpha})`
                ctx.shadowColor = `rgba(${colorAccent},${0.2 * glow * alpha})`
                ctx.shadowBlur = 6
                ctx.beginPath()
                ctx.arc(px, py, 2.5, 0, Math.PI * 2)
                ctx.fill()
                ctx.shadowBlur = 0
            }
        }
        let label = 'SQ'
        let labelColor = 'rgba(50,255,50,0.1)'
        if (waveformTarget === 'history') { label = 'LOG'; labelColor = 'rgba(50,255,50,0.20)' }
        else if (waveformTarget === 'rx') { label = 'RX'; labelColor = 'rgba(50,255,50,0.20)' }
        else if (waveformTarget === 'sq') { label = 'SQ'; labelColor = 'rgba(50,255,50,0.20)' }
        else if (isMine && isRecording) { label = 'TX'; labelColor = 'rgba(50,255,50,0.20)' }
        ctx.fillStyle = labelColor
        ctx.font = '9px monospace'
        ctx.fillText(label, 8, h - 8)
    }
    
    function connectWaveform(audioElement, targetType) {
        if (waveformConnected && waveformCurrentElement === audioElement && waveformTarget === targetType) {
            return
        }
        if (waveformSwitchCooldown) {
            return
        }
        try {
            if (waveformSource) {
                waveformSource.disconnect()
                waveformSource = null
            }
            if (waveformGainNode) {
                waveformGainNode.disconnect()
                waveformGainNode = null
            }
            waveformAnalyser = null
            waveformActive = false
            waveformConnected = false
            waveformCurrentElement = null
        } catch (e) {}
        if (!audioElement) {
            waveformTarget = targetType || 'none'
            drawStaticWaveform()
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        try {
            const ctx = getAudioContext()
            waveformAnalyser = ctx.createAnalyser()
            waveformAnalyser.fftSize = 1024
            waveformAnalyser.smoothingTimeConstant = waveformParams.smoothness
            waveformSource = ctx.createMediaElementSource(audioElement)
            waveformSource.connect(waveformAnalyser)
            waveformGainNode = ctx.createGain()
            waveformGainNode.gain.value = 1.0
            waveformSource.connect(waveformGainNode)
            waveformGainNode.connect(ctx.destination)
            waveformActive = true
            waveformConnected = true
            waveformTarget = targetType || 'unknown'
            waveformCurrentElement = audioElement
            if (globalRenderCallback) globalRenderCallback()
        } catch (e) {
            waveformTarget = 'none'
            drawStaticWaveform()
            if (globalRenderCallback) globalRenderCallback()
        }
    }
    
    function resetWaveformState() {
        try {
            if (waveformSource) {
                waveformSource.disconnect()
                waveformSource = null
            }
            if (waveformGainNode) {
                waveformGainNode.disconnect()
                waveformGainNode = null
            }
            waveformAnalyser = null
            waveformActive = false
            waveformConnected = false
            waveformCurrentElement = null
        } catch (e) {}
        waveformTarget = 'none'
        drawStaticWaveform()
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function updateWaveformTarget() {
        if (waveformSwitchCooldown) {
            setTimeout(function() {
                updateWaveformTarget()
            }, 50)
            return
        }
        if (isHistoryPlaying && historyAudioElement) {
            connectWaveform(historyAudioElement, 'history')
            return
        }
        if (isBroadcasting && !isMine && livePlaybackStarted && liveAudioElement) {
            connectWaveform(liveAudioElement, 'rx')
            return
        }
        if (isNoiseEnabled && sqPlaybackStarted && !sqPaused && sqAudioElement) {
            connectWaveform(sqAudioElement, 'sq')
            return
        }
        resetWaveformState()
    }
    
    function getPluginBasePath() {
        const scripts = document.getElementsByTagName('script')
        for (let i = 0; i < scripts.length; i++) {
            const src = scripts[i].src
            if (src && src.includes('WalkieTalkie')) {
                const match = src.match(/(.*\/plugins\/[^/]+)\//)
                if (match) return match[1]
            }
        }
        if (document.currentScript && document.currentScript.src) {
            const src = document.currentScript.src
            const match = src.match(/(.*\/plugins\/[^/]+)\//)
            if (match) return match[1]
        }
        return '/~/plugins/WalkieTalkie'
    }
    
    const pluginBasePath = getPluginBasePath()
    
    function getSoundPath(configPath, defaultFile) {
        if (configPath && configPath.trim() !== '') return configPath
        return pluginBasePath + '/' + defaultFile
    }
    
    function createSoundPlayer(url, loop) {
        if (!url) return null
        const audio = new Audio()
        audio.preload = 'none'
        audio.loop = loop || false
        audio.volume = 0.8
        return audio
    }
    
    function loadSoundAsync(audio, url) {
        return new Promise((resolve, reject) => {
            if (!audio) { resolve(null); return }
            if (audio.readyState >= 2) { resolve(audio); return }
            const onCanPlay = () => {
                audio.removeEventListener('canplaythrough', onCanPlay)
                audio.removeEventListener('loadeddata', onCanPlay)
                audio.removeEventListener('error', onError)
                resolve(audio)
            }
            const onError = (e) => {
                audio.removeEventListener('canplaythrough', onCanPlay)
                audio.removeEventListener('loadeddata', onCanPlay)
                audio.removeEventListener('error', onError)
                reject(e)
            }
            audio.addEventListener('canplaythrough', onCanPlay, { once: true })
            audio.addEventListener('loadeddata', onCanPlay, { once: true })
            audio.addEventListener('error', onError, { once: true })
            audio.src = url
            audio.load()
        })
    }
    
    function ensureSoundLoaded(type) {
        return new Promise(async (resolve) => {
            if (soundLoaded[type]) {
                resolve(type === 'start' ? startSound : endSound)
                return
            }
            if (soundLoading[type]) {
                const checkLoaded = () => {
                    if (soundLoaded[type]) {
                        resolve(type === 'start' ? startSound : endSound)
                    } else {
                        setTimeout(checkLoaded, 100)
                    }
                }
                checkLoaded()
                return
            }
            soundLoading[type] = true
            try {
                let audio = null, path = ''
                if (type === 'start') {
                    path = getSoundPath(cfg.startSound, 'start.mp3')
                    startSound = createSoundPlayer(path, false)
                    audio = startSound
                } else if (type === 'end') {
                    path = getSoundPath(cfg.endSound, 'end.mp3')
                    endSound = createSoundPlayer(path, false)
                    audio = endSound
                }
                if (audio && path) {
                    await loadSoundAsync(audio, path)
                    soundLoaded[type] = true
                }
            } catch {}
            soundLoading[type] = false
            resolve(type === 'start' ? startSound : endSound)
        })
    }
    
    function playSoundAsync(type) {
        return new Promise(async (resolve) => {
            const audio = await ensureSoundLoaded(type)
            if (!audio) { resolve(); return }
            try {
                audio.pause()
                audio.currentTime = 0
                audio.play().catch(() => {})
                setTimeout(resolve, 100)
            } catch { resolve() }
        })
    }
    
    function updateStatus(message, type) {
        statusMessage = message
        statusType = type || 'idle'
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function showToast(message, duration, isError) {
        toastMessage = message
        toastIsError = isError || false
        if (toastTimer) {
            clearTimeout(toastTimer)
            toastTimer = null
        }
        if (duration !== 0) {
            toastTimer = setTimeout(function() {
                toastMessage = ''
                toastIsError = false
                if (globalRenderCallback) globalRenderCallback()
            }, duration || 2000)
        }
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function updateButtonState() {
        var btn = document.querySelector('.menu-bar-walkie-btn')
        if (!btn) return
        var isConnected = ws && ws.readyState === 1
        if (isConnecting) {
            btn.title = 'Signal acquiring...'
            btn.style.opacity = '0.6'
        } else if (isConnected) {
            if (isBroadcasting) {
                btn.title = isMine ? 'Transmitting' : (currentBroadcaster?.username || 'Unit') + ' transmitting'
            } else {
                btn.title = 'Tactical Comms'
            }
            btn.style.opacity = '1'
        } else {
            btn.title = 'Signal lost'
            btn.style.opacity = '0.8'
        }
    }
    
    function formatHistoryTime(timestamp) {
        const d = new Date(timestamp)
        const month = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        const hour = String(d.getHours()).padStart(2, '0')
        const min = String(d.getMinutes()).padStart(2, '0')
        const sec = String(d.getSeconds()).padStart(2, '0')
        return month + '-' + day + ' ' + hour + ':' + min + ':' + sec
    }
    
    function getSignalBarsFromLatency(latency) {
        if (latency < 80) return 4
        if (latency < 180) return 3
        if (latency < 350) return 2
        if (latency < 600) return 1
        return 0
    }
    
    function doPing() {
        if (isPinging) return
        
        if (!keepAlive || !ws || ws.readyState !== 1) {
            if (signalBars !== 0) {
                signalBars = 0
                if (globalRenderCallback) globalRenderCallback()
            }
            return
        }
        
        isPinging = true
        const start = Date.now()
        
        fetch('/~/api/walkie/status', {
            method: 'HEAD',
            credentials: 'include',
            cache: 'no-cache'
        })
        .then((res) => {
            const latency = Date.now() - start
            isPinging = false
            const bars = getSignalBarsFromLatency(latency)
            if (signalBars !== bars) {
                signalBars = bars
                if (bars === 0) {
                    showToast('Signal lost', 1500)
                } else if (bars <= 1) {
                    showToast('Signal: ' + latency + 'ms', 1500)
                } else if (bars >= 3 && signalBars < 2) {
                    showToast('Signal restored', 1000)
                }
                if (globalRenderCallback) globalRenderCallback()
            }
        })
        .catch(() => {
            isPinging = false
            if (signalBars !== 0) {
                signalBars = 0
                showToast('Signal lost', 1500)
                if (globalRenderCallback) globalRenderCallback()
            }
        })
    }
    
    function startSignalMonitoring() {
        if (signalCheckTimer) {
            clearInterval(signalCheckTimer)
            signalCheckTimer = null
        }
        signalBars = 4
        if (globalRenderCallback) globalRenderCallback()
        setTimeout(doPing, 500)
        signalCheckTimer = setInterval(doPing, PING_INTERVAL)
    }
    
    function stopSignalMonitoring() {
        if (signalCheckTimer) {
            clearInterval(signalCheckTimer)
            signalCheckTimer = null
        }
        isPinging = false
        signalBars = 0
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function getNoiseEnabled() {
        try { return localStorage.getItem('walkie-noise-enabled') === 'true' } catch { return false }
    }
    
    function forceRefreshSQ() {
        if (sqForceRefreshTimer) {
            clearTimeout(sqForceRefreshTimer)
            sqForceRefreshTimer = null
        }
        if (!isNoiseEnabled) {
            sqPaused = true
            sqPlaybackStarted = false
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        if (isBroadcasting && !isMine) {
            sqPaused = true
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        sqForceRefreshTimer = setTimeout(function() {
            sqForceRefreshTimer = null
            resetWaveformState()
            if (sqAudioElement) {
                try {
                    sqAudioElement.pause()
                    sqAudioElement.src = ''
                } catch (e) {}
                sqAudioElement = null
            }
            sqPlaybackStarted = false
            sqPaused = true
            if (!ws || ws.readyState !== 1) {
                if (isNoiseEnabled) {
                    sqEnabled = true
                    sqPaused = false
                    sqPlaybackStartTime = Date.now()
                    loadSQAudio()
                }
                if (globalRenderCallback) globalRenderCallback()
                return
            }
            fetch('/~/api/walkie/sq-status', { credentials: 'include' })
                .then(res => res.json())
                .then(data => {
                    sqEnabled = data.enabled !== undefined ? data.enabled : true
                    sqPaused = data.paused !== undefined ? data.paused : false
                    sqPlaybackStartTime = data.playbackStartTime || Date.now()
                    sqTotalDuration = data.totalDuration || 0
                    if (sqEnabled && !sqPaused && isNoiseEnabled && (!isBroadcasting || isMine)) {
                        loadSQAudio()
                    } else {
                        sqPaused = true
                        sqPlaybackStarted = false
                        if (globalRenderCallback) globalRenderCallback()
                    }
                })
                .catch(function() {
                    if (isNoiseEnabled && (!isBroadcasting || isMine)) {
                        sqEnabled = true
                        sqPaused = false
                        sqPlaybackStartTime = Date.now()
                        loadSQAudio()
                    } else {
                        sqPaused = true
                        sqPlaybackStarted = false
                        if (globalRenderCallback) globalRenderCallback()
                    }
                })
        }, 400)
    }
    
    function loadSQAudio() {
        if (!isNoiseEnabled || !sqEnabled || sqPaused) {
            sqPlaybackStarted = false
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        if (isBroadcasting && !isMine) {
            sqPaused = true
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        if (sqAudioElement && sqAudioElement.src && !sqAudioElement.paused) {
            return
        }
        const noiseUrl = '/~/plugins/WalkieTalkie/noise.mp3'
        if (sqAudioElement) {
            try {
                sqAudioElement.pause()
                sqAudioElement.src = ''
            } catch (e) {}
            sqAudioElement = null
        }
        sqAudioElement = new Audio()
        sqAudioElement.volume = 1.0
        sqAudioElement.loop = true
        sqAudioElement.preload = 'auto'
        let isLoaded = false
        sqAudioElement.addEventListener('canplay', function onCanPlay() {
            if (isLoaded) return
            isLoaded = true
            sqPlaybackStarted = true
            if (!sqPaused && sqEnabled && isNoiseEnabled && (!isBroadcasting || isMine)) {
                syncSQPosition()
                sqAudioElement.play().catch(function(err) {})
            }
            setTimeout(function() {
                updateWaveformTarget()
            }, 100)
            if (globalRenderCallback) globalRenderCallback()
        })
        sqAudioElement.addEventListener('play', function onPlay() {
            sqPlaybackStarted = true
            setTimeout(function() {
                updateWaveformTarget()
            }, 100)
            if (globalRenderCallback) globalRenderCallback()
        })
        sqAudioElement.addEventListener('error', function onError(e) {
            isLoaded = false
        })
        sqAudioElement.src = noiseUrl + '?t=' + Date.now()
        sqAudioElement.load()
        sqAudioElement.addEventListener('loadedmetadata', function onLoaded() {
            sqAudioElement.removeEventListener('loadedmetadata', onLoaded)
            if (sqTotalDuration <= 0 && sqAudioElement.duration) {
                sqTotalDuration = sqAudioElement.duration * 1000
            }
            syncSQPosition()
            if (!sqPaused && sqEnabled && isNoiseEnabled && (!isBroadcasting || isMine)) {
                sqAudioElement.play().catch(function() {})
                sqPlaybackStarted = true
            }
            setTimeout(function() {
                updateWaveformTarget()
            }, 100)
            if (globalRenderCallback) globalRenderCallback()
        }, { once: true })
    }
    
    function syncSQPosition() {
        if (!sqAudioElement || sqTotalDuration <= 0 || sqPlaybackStartTime <= 0) return
        const elapsed = (Date.now() - sqPlaybackStartTime) / 1000
        const targetTime = elapsed % (sqTotalDuration / 1000)
        if (isFinite(targetTime) && targetTime > 0 && targetTime < sqAudioElement.duration) {
            const currentTime = sqAudioElement.currentTime || 0
            // ===== 同步阈值从 0.2 秒改为 0.05 秒 (50ms) =====
            if (Math.abs(currentTime - targetTime) > 0.05) {
                sqAudioElement.currentTime = targetTime
            }
        }
    }
    
    function initSQ() {
        if (!isNoiseEnabled || !keepAlive) {
            stopSQPlayback()
            return
        }
        if (!ws || ws.readyState !== 1) {
            setTimeout(initSQ, 1000)
            return
        }
        if (sqInitInProgress) return
        sqInitInProgress = true
        fetch('/~/api/walkie/sq-status', { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                sqEnabled = data.enabled !== undefined ? data.enabled : true
                sqPaused = data.paused !== undefined ? data.paused : false
                sqPlaybackStartTime = data.playbackStartTime || Date.now()
                sqTotalDuration = data.totalDuration || 0
                sqInitInProgress = false
                if (sqEnabled && !sqPaused && isNoiseEnabled && (!isBroadcasting || isMine)) {
                    loadSQAudio()
                } else {
                    sqPaused = true
                    sqPlaybackStarted = false
                    if (globalRenderCallback) globalRenderCallback()
                }
            })
            .catch(function() {
                sqInitInProgress = false
                setTimeout(initSQ, 2000)
            })
    }
    
    function pauseSQ() {
        resetWaveformState()
        if (sqAudioElement) {
            try { sqAudioElement.pause() } catch (e) {}
        }
        sqPaused = true
        sqPlaybackStarted = false
        updateWaveformTarget()
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function resumeSQ() {
        if (!isNoiseEnabled || !sqEnabled) {
            sqPaused = true
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        if (isBroadcasting && !isMine) {
            sqPaused = true
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        sqPaused = false
        if (sqAudioElement && sqAudioElement.src) {
            syncSQPosition()
            sqAudioElement.play().catch(function(err) {
                forceRefreshSQ()
            })
            sqPlaybackStarted = true
            setTimeout(function() {
                updateWaveformTarget()
            }, 100)
        } else {
            loadSQAudio()
        }
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function stopSQPlayback() {
        sqPaused = true
        sqPlaybackStarted = false
        resetWaveformState()
        if (sqAudioElement) {
            try {
                sqAudioElement.pause()
                sqAudioElement.src = ''
            } catch (e) {}
            sqAudioElement = null
        }
        updateWaveformTarget()
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function toggleSQ() {
        const newState = !isNoiseEnabled
        if (newState === isNoiseEnabled) return
        isNoiseEnabled = newState
        localStorage.setItem('walkie-noise-enabled', String(newState))
        if (newState) {
            fetch('/~/api/walkie/sq-status', { credentials: 'include' })
                .then(res => res.json())
                .then(data => {
                    sqEnabled = data.enabled !== undefined ? data.enabled : true
                    sqPaused = data.paused !== undefined ? data.paused : false
                    sqPlaybackStartTime = data.playbackStartTime || Date.now()
                    sqTotalDuration = data.totalDuration || 0
                    if (sqEnabled && !sqPaused && (!isBroadcasting || isMine)) {
                        loadSQAudio()
                    } else {
                        sqPaused = true
                        sqPlaybackStarted = false
                        if (globalRenderCallback) globalRenderCallback()
                    }
                    showToast('SQ Enabled', 1000)
                })
                .catch(function() {
                    sqEnabled = true
                    sqPaused = false
                    sqPlaybackStartTime = Date.now()
                    loadSQAudio()
                    showToast('SQ Enabled', 1000)
                })
        } else {
            stopSQPlayback()
            showToast('SQ Disabled', 1000)
        }
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function startRecording() {
        if (!micStream) {
            showToast('Microphone unavailable', 2000)
            return
        }
        if (mediaRecorder && mediaRecorder.state === 'recording') return
        try {
            var mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
            var mimeType = ''
            for (var i = 0; i < mimeTypes.length; i++) {
                if (MediaRecorder.isTypeSupported(mimeTypes[i])) {
                    mimeType = mimeTypes[i]
                    break
                }
            }
            mediaRecorder = new MediaRecorder(micStream, {
                mimeType: mimeType,
                audioBitsPerSecond: 48000
            })
            recordedChunks = []
            mediaRecorder.ondataavailable = function(event) {
                if (event.data && event.data.size > 0) {
                    recordedChunks.push(event.data)
                    sendLiveChunk(event.data)
                }
            }
            mediaRecorder.onstop = function() {
                if (recordedChunks.length > 0 && isMine) {
                    saveCompleteRecording()
                }
                releaseMicrophone()
            }
            mediaRecorder.start(RECORD_INTERVAL)
            isRecording = true
            updateStatus('Transmitting...', 'recording')
            if (globalRenderCallback) globalRenderCallback()
        } catch (e) {
            releaseMicrophone()
        }
    }
    
    function stopRecording() {
        releaseMicrophone()
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function sendLiveChunk(blob) {
        if (!isMine || !liveSessionId) return
        var reader = new FileReader()
        reader.onload = function(e) {
            try {
                var base64 = e.target.result.split(',')[1] || e.target.result
                fetch('/~/api/walkie/live-append', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ audio: base64, sessionId: liveSessionId })
                }).catch(() => {})
            } catch {}
        }
        reader.readAsDataURL(blob)
    }
    
    async function saveCompleteRecording() {
        if (recordedChunks.length === 0) return
        const durationMs = broadcastStartTime ? (Date.now() - broadcastStartTime) : recordedChunks.length * RECORD_INTERVAL
        const durationSec = durationMs / 1000
        if (durationMs < minRecordDuration) {
            recordedChunks = []
            broadcastStartTime = null
            if (globalRenderCallback) globalRenderCallback()
            return
        }
        try {
            var mimeType = mediaRecorder ? mediaRecorder.mimeType : 'audio/webm'
            var blob = new Blob(recordedChunks, { type: mimeType })
            var reader = new FileReader()
            reader.onload = async function(e) {
                try {
                    var base64 = e.target.result.split(',')[1] || e.target.result
                    const response = await fetch('/~/api/walkie/save-audio', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            audio: base64,
                            duration: durationSec,
                            mimeType: mimeType,
                            username: username,
                            startTime: broadcastStartTime || Date.now(),
                            endTime: Date.now()
                        })
                    })
                    const data = await response.json()
                    recordedChunks = []
                    if (ws && ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            type: 'historyUpdate',
                            senderId: myId,
                            timestamp: Date.now()
                        }))
                    }
                    broadcastStartTime = null
                    refreshHistory()
                    setTimeout(function() { if (globalRenderCallback) globalRenderCallback() }, 300)
                } catch {}
            }
            reader.readAsDataURL(blob)
        } catch {}
    }
    
    function createLiveAudioElement() {
        if (liveAudioElement) {
            try {
                liveAudioElement.pause()
                liveAudioElement.src = ''
            } catch (e) {}
        }
        liveAudioElement = new Audio()
        liveAudioElement.volume = 1.0
        liveAudioElement.preload = 'auto'
        return liveAudioElement
    }
    
    function stopLivePlayback() {
        livePlaybackStarted = false
        if (liveCheckInterval) {
            clearInterval(liveCheckInterval)
            liveCheckInterval = null
        }
        if (liveMediaSource && liveMediaSource.readyState === 'open') {
            try { liveMediaSource.endOfStream() } catch {}
        }
        if (liveAudioElement) {
            try {
                liveAudioElement.pause()
                liveAudioElement.src = ''
            } catch (e) {}
        }
        if (liveGainNode) {
            try { liveGainNode.disconnect() } catch (e) {}
            liveGainNode = null
        }
        if (liveAudioContext && liveAudioContext.state !== 'closed') {
            try { liveAudioContext.close() } catch (e) {}
            liveAudioContext = null
        }
        liveMediaSource = null
        liveSourceBuffer = null
        liveFileUrl = null
        liveFileSize = 0
        liveAppendQueue = []
        isAppending = false
        resetWaveformState()
        if (!isHistoryPlaying) {
            updateStatus('Standing by - Press PTT to transmit', 'idle')
        }
        setTimeout(function() {
            updateWaveformTarget()
        }, 300)
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function startLivePlayback(fileUrl) {
        if (livePlaybackStarted) {
            stopLivePlayback()
        }
        resetWaveformState()
        liveFileUrl = fileUrl
        liveFileSize = 0
        livePlaybackStarted = false
        liveAppendQueue = []
        isAppending = false
        try {
            liveAudioContext = new (window.AudioContext || window.webkitAudioContext)()
            if (liveAudioContext.state === 'suspended') {
                liveAudioContext.resume().catch(() => {})
            }
        } catch (e) {}
        createLiveAudioElement()
        const audio = liveAudioElement
        audio.volume = 1.0
        audio.src = ''
        try {
            if (!window.MediaSource) { 
                fallbackLivePlayback(fileUrl)
                return 
            }
            liveMediaSource = new MediaSource()
            audio.src = URL.createObjectURL(liveMediaSource)
            liveMediaSource.addEventListener('sourceopen', function onSourceOpen() {
                liveMediaSource.removeEventListener('sourceopen', onSourceOpen)
                try {
                    const codec = 'audio/webm;codecs=opus'
                    if (!MediaSource.isTypeSupported(codec)) {
                        const fallbackCodecs = ['audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
                        let found = false
                        for (const c of fallbackCodecs) {
                            if (MediaSource.isTypeSupported(c)) {
                                liveSourceBuffer = liveMediaSource.addSourceBuffer(c)
                                found = true
                                break
                            }
                        }
                        if (!found) throw new Error('No supported codec')
                    } else {
                        liveSourceBuffer = liveMediaSource.addSourceBuffer(codec)
                    }
                    liveSourceBuffer.mode = 'sequence'
                    liveSourceBuffer.addEventListener('updateend', function onUpdateEnd() {
                        liveSourceBuffer.removeEventListener('updateend', onUpdateEnd)
                        isAppending = false
                        processAppendQueue()
                    })
                    loadLiveSegment(fileUrl, 0, 32768)
                } catch (e) { 
                    fallbackLivePlayback(fileUrl) 
                }
            })
            audio.play().catch(function(err) {})
            startLivePolling(fileUrl)
            livePlaybackStarted = true
            updateStatus('Receiving transmission', 'listening')
            setTimeout(function() {
                updateWaveformTarget()
            }, 300)
            if (globalRenderCallback) globalRenderCallback()
        } catch (e) {
            fallbackLivePlayback(fileUrl)
        }
    }
    
    function processAppendQueue() {
        if (isAppending || liveAppendQueue.length === 0 || !liveSourceBuffer) return
        const item = liveAppendQueue.shift()
        if (!item) return
        isAppending = true
        try {
            liveSourceBuffer.appendBuffer(item.data)
        } catch {
            isAppending = false
            liveAppendQueue.unshift(item)
            setTimeout(processAppendQueue, 100)
        }
    }
    
    function loadLiveSegment(url, start, length) {
        const end = start + length - 1
        fetch(url, { headers: { 'Range': `bytes=${start}-${end}` } })
            .then(res => {
                if (res.status === 206 || res.status === 200) return res.arrayBuffer()
                return null
            })
            .then(data => {
                if (data && data.byteLength > 0 && liveSourceBuffer && !liveSourceBuffer.updating) {
                    try {
                        liveSourceBuffer.appendBuffer(data)
                        liveFileSize = start + data.byteLength
                    } catch {
                        setTimeout(() => {
                            if (liveSourceBuffer && !liveSourceBuffer.updating) {
                                try { liveSourceBuffer.appendBuffer(data) } catch {}
                            }
                        }, 500)
                    }
                }
            })
            .catch(() => {})
    }
    
    function startLivePolling(fileUrl) {
        if (liveCheckInterval) clearInterval(liveCheckInterval)
        let lastSize = 0
        liveCheckInterval = setInterval(() => {
            if (!livePlaybackStarted) {
                clearInterval(liveCheckInterval)
                liveCheckInterval = null
                return
            }
            fetch(fileUrl, { method: 'HEAD' })
                .then(res => {
                    const size = parseInt(res.headers.get('content-length') || '0')
                    if (size > lastSize) {
                        lastSize = size
                        if (!livePlaybackStarted && size > 8192) {
                            livePlaybackStarted = true
                            if (liveAudioElement) {
                                liveAudioElement.play().catch(() => {})
                            }
                            updateStatus('Receiving transmission', 'listening')
                            updateWaveformTarget()
                            if (globalRenderCallback) globalRenderCallback()
                        }
                        if (liveSourceBuffer && !liveSourceBuffer.updating && livePlaybackStarted) {
                            const start = liveFileSize || 0
                            if (size > start) {
                                const length = Math.min(size - start, 65536)
                                loadLiveSegment(fileUrl, start, length)
                            }
                        }
                    }
                })
                .catch(() => {})
        }, 300)
    }
    
    function fallbackLivePlayback(fileUrl) {
        const audio = liveAudioElement
        if (!audio) {
            createLiveAudioElement()
        }
        fetch(fileUrl, { method: 'HEAD' })
            .then(res => {
                const size = parseInt(res.headers.get('content-length') || '0')
                if (size > 0) {
                    audio.src = fileUrl + '?t=' + Date.now()
                    audio.load()
                    audio.play().catch(function(err) {})
                    livePlaybackStarted = true
                    setTimeout(function() {
                        updateWaveformTarget()
                    }, 300)
                    if (liveCheckInterval) clearInterval(liveCheckInterval)
                    liveCheckInterval = setInterval(() => {
                        if (!livePlaybackStarted) {
                            clearInterval(liveCheckInterval)
                            liveCheckInterval = null
                            return
                        }
                        fetch(fileUrl, { method: 'HEAD' })
                            .then(res2 => {
                                const newSize = parseInt(res2.headers.get('content-length') || '0')
                                if (newSize > liveFileSize) {
                                    liveFileSize = newSize
                                    const currentTime = audio.currentTime || 0
                                    audio.src = fileUrl + '?t=' + Date.now()
                                    audio.load()
                                    audio.addEventListener('canplay', function onCanPlay() {
                                        if (audio.duration > currentTime + 1) {
                                            audio.currentTime = currentTime
                                        }
                                        audio.removeEventListener('canplay', onCanPlay)
                                    }, { once: true })
                                    if (audio.paused) audio.play().catch(() => {})
                                }
                            })
                            .catch(() => {})
                    }, 2000)
                } else {
                    setTimeout(() => fallbackLivePlayback(fileUrl), 1000)
                }
            })
            .catch(() => setTimeout(() => fallbackLivePlayback(fileUrl), 1000))
    }
    
    function playHistoryRecord(record) {
        if (!record || !record.filePath) return
        if (record.id) {
            readHistoryIds.add(record.id)
            try {
                localStorage.setItem('walkie-read-history', JSON.stringify([...readHistoryIds]))
            } catch (e) {}
            if (globalRenderCallback) globalRenderCallback()
        }
        if (isHistoryPlaying && historyPlaybackRecord && historyPlaybackRecord.id === record.id) {
            stopHistoryPlayback()
            return
        }
        if (isHistoryPlaying) stopHistoryPlayback()
        pauseSQ()
        const audioUrl = '/~/api/walkie/audio?path=' + encodeURIComponent(record.filePath)
        const audio = new Audio(audioUrl)
        audio.volume = 1.0
        audio.addEventListener('ended', function() {
            isHistoryPlaying = false
            historyPlaybackRecord = null
            forceRefreshSQ()
            if (globalRenderCallback) globalRenderCallback()
        })
        audio.addEventListener('error', function() {
            isHistoryPlaying = false
            historyPlaybackRecord = null
            forceRefreshSQ()
            if (globalRenderCallback) globalRenderCallback()
        })
        audio.addEventListener('play', function() {
            historyAudioElement = audio
            isHistoryPlaying = true
            historyPlaybackRecord = record
            connectWaveform(audio, 'history')
            if (globalRenderCallback) globalRenderCallback()
        })
        audio.play().catch(function() {
            isHistoryPlaying = false
            historyPlaybackRecord = null
            forceRefreshSQ()
            if (globalRenderCallback) globalRenderCallback()
        })
    }
    
    function stopHistoryPlayback() {
        isHistoryPlaying = false
        historyPlaybackRecord = null
        if (historyAudioElement) {
            historyAudioElement.pause()
            historyAudioElement.src = ''
        }
        forceRefreshSQ()
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function loadHistory(callback) {
        if (isLoadingHistory) {
            const checkDone = () => {
                if (isLoadingHistory) setTimeout(checkDone, 100)
                else if (callback) callback(cachedHistory)
            }
            checkDone()
            return
        }
        if (historyLoadTimeout) clearTimeout(historyLoadTimeout)
        historyLoadTimeout = setTimeout(() => {
            historyLoadTimeout = null
            doLoadHistory(callback)
        }, 200)
    }
    
    async function doLoadHistory(callback) {
        if (isLoadingHistory) return
        isLoadingHistory = true
        try {
            const res = await fetch('/~/api/walkie/history', { credentials: 'include' })
            const data = await res.json()
            const records = data.records || []
            records.sort((a, b) => b.timestamp - a.timestamp)
            try {
                const saved = localStorage.getItem('walkie-read-history')
                if (saved) {
                    const ids = JSON.parse(saved)
                    readHistoryIds = new Set(ids)
                }
            } catch (e) {}
            cachedHistory = records
            historyLoaded = true
            if (callback) callback(records)
            if (globalRenderCallback) globalRenderCallback()
        } catch {
            if (callback) callback([])
        } finally {
            isLoadingHistory = false
            if (globalRenderCallback) globalRenderCallback()
        }
    }
    
    function refreshHistory() {
        isLoadingHistory = false
        historyLoaded = false
        loadHistory(function(records) {
            cachedHistory = records
            if (globalRenderCallback) globalRenderCallback()
        })
    }
    
    let spacePressed = false
    
    function setupKeyboardBindings() {
        document.addEventListener('keydown', function(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                return
            }
            if (e.code === 'Space' && globalIsOpen) {
                e.preventDefault()
                if (!spacePressed) {
                    spacePressed = true
                    if (keepAlive && ws && ws.readyState === 1) {
                        startPTT()
                    } else if (!keepAlive) {
                        showToast('Enable Online mode first', 1500)
                    }
                }
            }
        })
        document.addEventListener('keyup', function(e) {
            if (e.code === 'Space' && globalIsOpen) {
                e.preventDefault()
                spacePressed = false
                if (isRecording || isMine) {
                    stopPTT()
                }
            }
        })
        document.addEventListener('blur', function() {
            if (spacePressed) {
                spacePressed = false
                if (isRecording || isMine) {
                    stopPTT()
                }
            }
        })
    }
    
    function startPTT() {
        if (!keepAlive) {
            showToast('Enable Online mode first', 2000)
            return
        }
        if (!ws || ws.readyState !== 1) {
            showToast('Signal lost - Check connection', 2000)
            return
        }
        if (isBroadcasting && !isMine) {
            showToast('Channel busy - Unit transmitting', 2000)
            return
        }
        if (endDelayTimer) {
            clearTimeout(endDelayTimer)
            endDelayTimer = null
        }
        if (isHistoryPlaying) stopHistoryPlayback()
        pauseSQ()
        isMine = true
        isBroadcasting = true
        currentBroadcaster = { username: username }
        recordedChunks = []
        broadcastStartTime = Date.now()
        stopLivePlayback()
        playSoundAsync('start').then(() => {})
        releaseMicrophone()
        initMicrophone().then(function(success) {
            if (!success) {
                isMine = false
                isBroadcasting = false
                currentBroadcaster = null
                broadcastStartTime = null
                releaseMicrophone()
                forceRefreshSQ()
                updateStatus('Standing by - Press PTT to transmit', 'idle')
                if (globalRenderCallback) globalRenderCallback()
                return
            }
            fetch('/~/api/walkie/live-start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include'
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    liveSessionId = data.session.sessionId
                    ws.send(JSON.stringify({
                        type: 'broadcastStart',
                        senderId: myId,
                        broadcaster: username,
                        timestamp: Date.now(),
                        filePath: data.session.filePath,
                        startTime: broadcastStartTime
                    }))
                    startRecording()
                    updateStatus('Transmitting', 'mine')
                    if (globalRenderCallback) globalRenderCallback()
                } else {
                    isMine = false
                    isBroadcasting = false
                    currentBroadcaster = null
                    broadcastStartTime = null
                    releaseMicrophone()
                    forceRefreshSQ()
                    showToast('Transmission failed', 2000)
                    updateStatus('Standing by - Press PTT to transmit', 'idle')
                    if (globalRenderCallback) globalRenderCallback()
                }
            })
            .catch(function() {
                isMine = false
                isBroadcasting = false
                currentBroadcaster = null
                broadcastStartTime = null
                releaseMicrophone()
                forceRefreshSQ()
                showToast('Transmission failed', 2000)
                updateStatus('Standing by - Press PTT to transmit', 'idle')
                if (globalRenderCallback) globalRenderCallback()
            })
        })
    }
    
    function stopPTT() {
        releaseMicrophone()
        if (endDelayTimer) {
            clearTimeout(endDelayTimer)
            endDelayTimer = null
        }
        endDelayTimer = setTimeout(function() {
            endDelayTimer = null
            if (isMine) {
                const duration = broadcastStartTime ? (Date.now() - broadcastStartTime) / 1000 : 0
                playSoundAsync('end').then(() => {})
                ws.send(JSON.stringify({
                    type: 'broadcastEnd',
                    senderId: myId,
                    broadcaster: username,
                    timestamp: Date.now(),
                    duration: duration,
                    startTime: broadcastStartTime,
                    endTime: Date.now()
                }))
                fetch('/~/api/walkie/live-end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include'
                }).catch(() => {})
                isMine = false
                isBroadcasting = false
                currentBroadcaster = null
                liveSessionId = null
                broadcastStartTime = null
                updateStatus('Standing by - Press PTT to transmit', 'idle')
                forceRefreshSQ()
                if (globalRenderCallback) globalRenderCallback()
            }
        }, END_DELAY)
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function connect() {
        if (ws && ws.readyState === 1) return
        if (isConnecting) return
        if (!keepAlive) return
        try {
            isConnecting = true
            isManualClose = false
            var wsUrl = 'ws://' + location.hostname + ':' + WS_PORT
            ws = new WebSocket(wsUrl)
            ws.onopen = function() {
                isConnecting = false
                updateStatus('Standing by - Press PTT to transmit', 'idle')
                ws.send(JSON.stringify({
                    type: 'identify',
                    username: username,
                    clientId: myId
                }))
                isNoiseEnabled = getNoiseEnabled()
                if (isNoiseEnabled) {
                    setTimeout(initSQ, 800)
                }
                loadHistory()
                setTimeout(function() {
                    refreshHistory()
                }, 1000)
                setTimeout(function() {
                    if (!historyLoaded && !isLoadingHistory) {
                        refreshHistory()
                    }
                }, 3000)
                updateButtonState()
                if (globalRenderCallback) globalRenderCallback()
                startSignalMonitoring()
                fetch('/~/api/walkie/status', { credentials: 'include' })
                    .then(res => res.json())
                    .then(data => {
                        if (data.minRecordDuration) {
                            minRecordDuration = data.minRecordDuration
                        }
                    })
                    .catch(() => {})
            }
            ws.onmessage = function(event) {
                try {
                    var msg = JSON.parse(event.data)
                    if (msg.senderId === myId) return
                    
                    if (msg.type === 'sqProgress') {
                        sqPlaybackStartTime = msg.playbackStartTime
                        sqTotalDuration = msg.totalDuration || sqTotalDuration
                        if (sqAudioElement && sqTotalDuration > 0 && !sqPaused && sqEnabled && isNoiseEnabled) {
                            const elapsed = (Date.now() - sqPlaybackStartTime) / 1000
                            const targetTime = elapsed % (sqTotalDuration / 1000)
                            if (isFinite(targetTime) && targetTime > 0 && targetTime < sqAudioElement.duration) {
                                const currentTime = sqAudioElement.currentTime || 0
                                // ===== 同步阈值从 0.2 秒改为 0.05 秒 (50ms) =====
                                if (Math.abs(currentTime - targetTime) > 0.05) {
                                    sqAudioElement.currentTime = targetTime
                                }
                            }
                        }
                        if (globalRenderCallback) globalRenderCallback()
                        return
                    }
                    
                    if (msg.type === 'sqStateChange') {
                        releaseMicrophone()
                        sqEnabled = msg.enabled
                        if (msg.playbackStartTime) sqPlaybackStartTime = msg.playbackStartTime
                        if (msg.totalDuration) sqTotalDuration = msg.totalDuration
                        if (msg.isPlaying !== undefined) {
                            const shouldPlay = msg.isPlaying && sqEnabled && isNoiseEnabled
                            if (!shouldPlay && !sqPaused) {
                                if (sqAudioElement) {
                                    sqAudioElement.pause()
                                }
                                sqPaused = true
                                sqPlaybackStarted = false
                            } else if (shouldPlay && sqPaused) {
                                if (!isBroadcasting || isMine) {
                                    resumeSQ()
                                } else {
                                    sqPaused = false
                                }
                            }
                        }
                        if (!sqEnabled && sqAudioElement) {
                            sqAudioElement.pause()
                            sqPaused = true
                            sqPlaybackStarted = false
                        } else if (sqEnabled && sqAudioElement && sqPaused && isNoiseEnabled) {
                            if (!isBroadcasting || isMine) {
                                sqAudioElement.play().catch(() => {})
                                sqPaused = false
                                sqPlaybackStarted = true
                                syncSQPosition()
                                setTimeout(function() {
                                    updateWaveformTarget()
                                }, 100)
                            }
                        }
                        if (globalRenderCallback) globalRenderCallback()
                        return
                    }
                    
                    if (msg.type === 'historyUpdate') {
                        refreshHistory()
                        return
                    }
                    
                    if (msg.type === 'broadcastEnd' && msg.ignored) {
                        releaseMicrophone()
                        const durationStr = msg.duration ? formatDuration(msg.duration) : ''
                        showToast((msg.broadcaster || 'Unit') + ' transmission too short' + 
                                 (durationStr ? ' (' + durationStr + ')' : '') + ' [ignored]', 2000)
                        return
                    }
                    
                    handleMessage(msg)
                } catch (e) {}
            }
            ws.onclose = function(e) {
                isConnecting = false
                isBroadcasting = false
                isMine = false
                isRecording = false
                liveSessionId = null
                broadcastStartTime = null
                if (mediaRecorder) {
                    try { mediaRecorder.stop() } catch {}
                    mediaRecorder = null
                }
                releaseMicrophone()
                stopLivePlayback()
                if (endDelayTimer) {
                    clearTimeout(endDelayTimer)
                    endDelayTimer = null
                }
                stopSignalMonitoring()
                updateStatus('Offline', 'offline')
                updateButtonState()
                if (globalRenderCallback) globalRenderCallback()
                if (!isManualClose && keepAlive) {
                    reconnectTimeoutId = setTimeout(connect, 2000)
                }
            }
            ws.onerror = function() {
                updateStatus('Signal error', 'offline')
            }
        } catch (e) {}
    }
    
    function disconnect() {
        isManualClose = true
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId)
            reconnectTimeoutId = null
        }
        if (ws) {
            try { ws.close(1000, 'User disconnect') } catch {}
            ws = null
        }
        isConnecting = false
        isBroadcasting = false
        isMine = false
        isRecording = false
        liveSessionId = null
        broadcastStartTime = null
        stopSignalMonitoring()
        stopSQPlayback()
        releaseMicrophone()
        if (endDelayTimer) {
            clearTimeout(endDelayTimer)
            endDelayTimer = null
        }
        stopLivePlayback()
        stopHistoryPlayback()
        resetWaveformState()
        updateStatus('Offline', 'offline')
        updateButtonState()
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function disconnectAll() {
        isManualClose = true
        isAppClosed = true
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId)
            reconnectTimeoutId = null
        }
        if (ws) {
            try { ws.close(1000, 'User disconnect') } catch {}
            ws = null
        }
        isConnecting = false
        stopSignalMonitoring()
        stopSQPlayback()
        releaseMicrophone()
        if (endDelayTimer) {
            clearTimeout(endDelayTimer)
            endDelayTimer = null
        }
        stopLivePlayback()
        stopHistoryPlayback()
        resetWaveformState()
        isBroadcasting = false
        isMine = false
        isRecording = false
        liveSessionId = null
        broadcastStartTime = null
        updateStatus('Offline', 'offline')
        updateButtonState()
        if (globalRenderCallback) globalRenderCallback()
    }
    
    function handleMessage(msg) {
        switch (msg.type) {
            case 'broadcastStart':
                pauseSQ()
                if (isHistoryPlaying) stopHistoryPlayback()
                isBroadcasting = true
                currentBroadcaster = { username: msg.broadcaster }
                playSoundAsync('start').then(() => {})
                stopLivePlayback()
                const fileUrl = '/~/api/walkie/live-stream?path=' + encodeURIComponent(msg.filePath || '')
                const caller = msg.broadcaster || 'Unknown unit'
                updateStatus(caller + ' transmitting', 'listening')
                showToast(caller + ' transmitting', 2000)
                startLivePlayback(fileUrl)
                if (globalRenderCallback) globalRenderCallback()
                break
            case 'broadcastEnd':
                releaseMicrophone()
                playSoundAsync('end').then(() => {})
                isBroadcasting = false
                if (msg.broadcaster === username) {
                    isMine = false
                    liveSessionId = null
                    broadcastStartTime = null
                }
                currentBroadcaster = null
                stopLivePlayback()
                const durationStr = msg.duration ? formatDuration(msg.duration) : ''
                const durationMs = msg.duration ? msg.duration * 1000 : 0
                const isShort = durationMs > 0 && durationMs < minRecordDuration
                const endMsg = (msg.broadcaster || 'Unit') + ' transmission ended' + 
                               (durationStr ? ' (' + durationStr + ')' : '') +
                               (isShort ? ' [too short, ignored]' : '')
                showToast(endMsg, 2000)
                forceRefreshSQ()
                if (globalRenderCallback) globalRenderCallback()
                break
        }
    }
    
    function WalkieTalkiePanel(props) {
        var onClose = props.onClose
        var panelRef = useRef(null)
        var closingRef = useRef(false)
        
        var _history = useState(cachedHistory)
        var history = _history[0]
        var setHistory = _history[1]
        
        var _isLoadingHistory = useState(isLoadingHistory)
        var isLoadingHistoryState = _isLoadingHistory[0]
        var setIsLoadingHistoryState = _isLoadingHistory[1]
        
        var _localIsConnected = useState(ws && ws.readyState === 1)
        var localIsConnected = _localIsConnected[0]
        var setLocalIsConnected = _localIsConnected[1]
        
        var _localIsBroadcasting = useState(isBroadcasting)
        var localIsBroadcasting = _localIsBroadcasting[0]
        var setLocalIsBroadcasting = _localIsBroadcasting[1]
        
        var _localIsMine = useState(isMine)
        var localIsMine = _localIsMine[0]
        var setLocalIsMine = _localIsMine[1]
        
        var _localIsRecording = useState(isRecording)
        var localIsRecording = _localIsRecording[0]
        var setLocalIsRecording = _localIsRecording[1]
        
        var _localBroadcaster = useState(currentBroadcaster)
        var localBroadcaster = _localBroadcaster[0]
        var setLocalBroadcaster = _localBroadcaster[1]
        
        var _closing = useState(false)
        var closing = _closing[0]
        var setClosing = _closing[1]
        
        var _isMobile = useState(window.innerWidth <= 768)
        var isMobile = _isMobile[0]
        var setIsMobile = _isMobile[1]
        
        var _statusMsg = useState(statusMessage)
        var statusMsg = _statusMsg[0]
        var setStatusMsg = _statusMsg[1]
        
        var _statusType = useState(statusType)
        var statusTypeState = _statusType[0]
        var setStatusType = _statusType[1]
        
        var _toastMsg = useState(toastMessage)
        var toastMsg = _toastMsg[0]
        var setToastMsg = _toastMsg[1]
        
        var _toastIsError = useState(toastIsError)
        var toastIsErrorState = _toastIsError[0]
        var setToastIsError = _toastIsError[1]
        
        var _isHistoryPlaying = useState(isHistoryPlaying)
        var isHistoryPlayingState = _isHistoryPlaying[0]
        var setIsHistoryPlayingState = _isHistoryPlaying[1]
        
        var _localNoiseEnabled = useState(isNoiseEnabled)
        var localNoiseEnabled = _localNoiseEnabled[0]
        var setLocalNoiseEnabled = _localNoiseEnabled[1]
        
        var _localKeepAlive = useState(keepAlive)
        var localKeepAlive = _localKeepAlive[0]
        var setLocalKeepAlive = _localKeepAlive[1]
        
        var _signalBars = useState(signalBars)
        var signalBarsState = _signalBars[0]
        var setSignalBars = _signalBars[1]
        
        var waveformContainerRef = useRef(null)
        var waveformInitialized = useRef(false)
        
        closingRef.current = closing
        
        var isDesktopDevice = useCallback(function() {
            return window.innerWidth > 768 && !('ontouchstart' in window)
        }, [])
        
        useEffect(function() {
            if (!isDesktopDevice()) return
            function handleClickOutside(e) {
                var panel = panelRef.current
                if (!panel || closingRef.current) return
                var rect = panel.getBoundingClientRect()
                var margin = 100
                var isOutside = (
                    e.clientX < rect.left - margin ||
                    e.clientX > rect.right + margin ||
                    e.clientY < rect.top - margin ||
                    e.clientY > rect.bottom + margin
                )
                if (isOutside) {
                    handleClose()
                }
            }
            document.addEventListener('mousedown', handleClickOutside)
            return function() {
                document.removeEventListener('mousedown', handleClickOutside)
            }
        }, [isDesktopDevice])
        
        function isRead(recordId) {
            return recordId && readHistoryIds.has(recordId)
        }
        
        useEffect(function() {
            if (cachedHistory.length > 0) setHistory(cachedHistory)
            setIsLoadingHistoryState(isLoadingHistory)
        }, [cachedHistory.length, isLoadingHistory])
        
        useEffect(function() {
            function handleResize() {
                setIsMobile(window.innerWidth <= 768)
            }
            window.addEventListener('resize', handleResize)
            return function() { window.removeEventListener('resize', handleResize) }
        }, [])
        
        useEffect(function() {
            globalRenderCallback = function() {
                setLocalIsConnected(ws && ws.readyState === 1)
                setLocalIsBroadcasting(isBroadcasting)
                setLocalIsMine(isMine)
                setLocalIsRecording(isRecording)
                setLocalBroadcaster(currentBroadcaster)
                setStatusMsg(statusMessage)
                setStatusType(statusType)
                setToastMsg(toastMessage)
                setToastIsError(toastIsError)
                setIsHistoryPlayingState(isHistoryPlaying)
                setLocalNoiseEnabled(isNoiseEnabled)
                setLocalKeepAlive(keepAlive)
                setIsLoadingHistoryState(isLoadingHistory)
                setSignalBars(signalBars)
                if (cachedHistory.length > 0) setHistory(cachedHistory)
                updateButtonState()
            }
            return function() { globalRenderCallback = null }
        }, [])
        
        useEffect(function() {
            var interval = setInterval(function() {
                setLocalIsConnected(ws && ws.readyState === 1)
                setLocalIsBroadcasting(isBroadcasting)
                setLocalIsMine(isMine)
                setLocalIsRecording(isRecording)
                setLocalBroadcaster(currentBroadcaster)
                setStatusMsg(statusMessage)
                setStatusType(statusType)
                setLocalNoiseEnabled(isNoiseEnabled)
                setLocalKeepAlive(keepAlive)
                setSignalBars(signalBars)
                updateButtonState()
            }, 300)
            return function() { clearInterval(interval) }
        }, [])
        
        useEffect(function() {
            isAppClosed = false
            if (keepAlive) connect()
            setupKeyboardBindings()
            return function() {
                isAppClosed = true
                if (!keepAlive) {
                    disconnectAll()
                } else {
                    if (mediaRecorder) {
                        try { mediaRecorder.stop() } catch {}
                        mediaRecorder = null
                    }
                    releaseMicrophone()
                    stopLivePlayback()
                    stopHistoryPlayback()
                }
            }
        }, [])
        
        useEffect(function() {
            if (waveformContainerRef.current && !waveformInitialized.current) {
                waveformInitialized.current = true
                initWaveform(waveformContainerRef.current)
                setTimeout(updateWaveformTarget, 300)
            }
        }, [])
        
        var handleClose = useCallback(function() {
            if (closingRef.current) return
            setClosing(true)
            setTimeout(onClose, 300)
        }, [onClose])
        
        function handleNoiseToggle() {
            toggleSQ()
            setLocalNoiseEnabled(isNoiseEnabled)
        }
        
        function handleKeepAliveToggle() {
            const newState = !keepAlive
            setKeepAlive(newState)
            setLocalKeepAlive(newState)
            if (newState) {
                isAppClosed = false
                isManualClose = false
                connect()
                if (isNoiseEnabled) setTimeout(initSQ, 500)
                showToast('Online mode enabled', 1500)
            } else {
                disconnectAll()
                showToast('Offline - All connections disconnected', 1500)
            }
        }
        
        function handleRefreshHistory() {
            setIsLoadingHistoryState(true)
            refreshHistory()
            setTimeout(() => {
                setIsLoadingHistoryState(false)
                if (globalRenderCallback) globalRenderCallback()
            }, 500)
        }
        
        function handleHistoryClick(record) {
            playHistoryRecord(record)
        }
        
        function getPttButtonClass() {
            var classes = 'walkie-ptt-btn'
            if (localIsMine) classes += ' broadcasting'
            if (localIsRecording) classes += ' recording'
            if (localIsBroadcasting && !localIsMine) classes += ' listening'
            if (!localKeepAlive || !localIsConnected) classes += ' disabled'
            return classes
        }
        
        function getPttButtonText() {
            if (!localKeepAlive) return 'OFFLINE'
            if (localIsMine) return localIsRecording ? 'TX' : 'PTT'
            if (localIsBroadcasting) return 'RX'
            return 'PTT'
        }
        
        function renderSignalBars() {
            var bars = signalBarsState || 0
            var barClass = 'walkie-signal-bars'
            if (bars <= 1) barClass += ' poor'
            if (bars === 0) barClass += ' offline'
            var title = bars >= 4 ? 'Signal: 4/4' :
                        bars === 3 ? 'Signal: 3/4' :
                        bars === 2 ? 'Signal: 2/4' :
                        bars === 1 ? 'Signal: 1/4' : 'No signal'
            return h('div', {
                className: barClass,
                title: title
            }, [
                h('span', { className: 'signal-bar' + (bars >= 1 ? ' active' : '') }),
                h('span', { className: 'signal-bar' + (bars >= 2 ? ' active' : '') }),
                h('span', { className: 'signal-bar' + (bars >= 3 ? ' active' : '') }),
                h('span', { className: 'signal-bar' + (bars >= 4 ? ' active' : '') })
            ])
        }
        
        var panelClass = 'walkie-panel ' + (isMobile ? 'walkie-mobile' : 'walkie-desktop') + (closing ? ' walkie-closing' : '')
        
        return h('div', { 
            className: panelClass,
            ref: panelRef
        }, [
            h('div', { className: 'walkie-panel-header' }, [
                h('div', { className: 'walkie-panel-title' }, [
                    h('span', {}, 'Tactical Comms'),
                    h('span', {
                        className: 'walkie-status ' + (localIsConnected ? 'online' : 'offline')
                    }, [
                        h('span', { className: 'walkie-status-dot' }, localIsConnected ? '●' : '○'),
                        h('span', { className: 'walkie-status-label' }, localIsConnected ? 'Online' : 'Offline')
                    ]),
                    renderSignalBars()
                ]),
                h('button', {
                    className: 'walkie-close-btn',
                    onClick: handleClose
                }, '✕')
            ]),
            
            h('div', {
                ref: waveformContainerRef,
                className: 'walkie-waveform-container'
            }),
            
            h('div', { className: 'walkie-status-display' }, [
                h('div', { className: 'walkie-status-left' }, [
                    h('span', {
                        className: 'walkie-status-icon' + ((statusTypeState === 'recording' || statusTypeState === 'mine' || statusTypeState === 'listening') ? ' pulse' : '')
                    }, statusTypeState === 'recording' ? '●' : statusTypeState === 'mine' ? '●' : statusTypeState === 'listening' ? '▶' : (localIsConnected ? '○' : '○')),
                    h('span', { className: 'walkie-status-text' }, statusMsg)
                ]),
                h('div', { className: 'walkie-toggle-group' }, [
                    h('label', {
                        className: 'walkie-toggle-label' + (localNoiseEnabled ? ' active' : ''),
                        onClick: function(e) { e.stopPropagation() }
                    }, [
                        h('input', {
                            type: 'checkbox',
                            checked: localNoiseEnabled,
                            onChange: handleNoiseToggle
                        }),
                        h('span', { className: 'toggle-label-text' }, 'SQ')
                    ]),
                    h('label', {
                        className: 'walkie-toggle-label' + (localKeepAlive ? ' active' : ''),
                        onClick: function(e) { e.stopPropagation() }
                    }, [
                        h('input', {
                            type: 'checkbox',
                            checked: localKeepAlive,
                            onChange: handleKeepAliveToggle
                        }),
                        h('span', { className: 'toggle-label-text' }, 'Online')
                    ])
                ])
            ]),
            
            h('button', {
                className: getPttButtonClass(),
                onMouseDown: function(e) {
                    e.preventDefault()
                    if (localKeepAlive && localIsConnected) startPTT()
                    else if (!localKeepAlive) showToast('Enable Online mode first', 1500)
                },
                onMouseUp: function(e) {
                    e.preventDefault()
                    if (localIsRecording || localIsMine) stopPTT()
                },
                onMouseLeave: function(e) {
                    if (localIsRecording || localIsMine) stopPTT()
                },
                onTouchStart: function(e) {
                    e.preventDefault()
                    if (localKeepAlive && localIsConnected) startPTT()
                    else if (!localKeepAlive) showToast('Enable Online mode first', 1500)
                },
                onTouchEnd: function(e) {
                    e.preventDefault()
                    if (localIsRecording || localIsMine) stopPTT()
                },
                disabled: !localKeepAlive || !localIsConnected
            }, getPttButtonText()),
            
            h('div', { className: 'walkie-help' }, [
                h('span', {}, localKeepAlive ? '[Space] Hold to transmit' : 'Enable Online mode'),
                localIsBroadcasting && !localIsMine ? h('span', { 
                    className: 'walkie-interrupt-hint' 
                }, 'RX') : null
            ]),
            
            h('div', { className: 'walkie-history-section' }, [
                h('div', { className: 'walkie-history-header' }, [
                    h('span', {}, 'Comm Log'),
                    h('div', { className: 'walkie-history-header-right' }, [
                        toastMsg ? h('span', { 
                            className: 'walkie-toast-inline' + (toastIsErrorState ? ' walkie-toast-inline-error' : '')
                        }, toastMsg) : null,
                        h('button', {
                            className: 'walkie-history-refresh',
                            onClick: handleRefreshHistory
                        }, '↻')
                    ])
                ]),
                h('div', { className: 'walkie-history-list' },
                    isLoadingHistoryState ? 
                        h('div', { className: 'walkie-history-empty' }, 'Loading...') :
                    history.length === 0 ?
                        h('div', { className: 'walkie-history-empty' }, 'No transmissions logged') :
                        history.map(function(record) {
                            var displayTime = formatHistoryTime(record.timestamp || Date.now())
                            var durationStr = record.duration ? formatDuration(record.duration) : '00:00'
                            var usernameStr = record.username || 'Anonymous'
                            var isReadStatus = isRead(record.id)
                            var statusIcon = isReadStatus ? '○' : '●'
                            var isPlaying = isHistoryPlayingState && historyPlaybackRecord && historyPlaybackRecord.id === record.id
                            return h('div', {
                                key: record.id,
                                className: 'walkie-history-item' + (isPlaying ? ' playing' : ''),
                                onClick: function() { handleHistoryClick(record) }
                            }, [
                                h('span', { className: 'walkie-history-status' }, statusIcon),
                                h('span', { className: 'walkie-history-time' }, displayTime),
                                h('span', { className: 'walkie-history-sep' }, '-'),
                                h('span', { className: 'walkie-history-name' }, usernameStr),
                                h('span', { className: 'walkie-history-duration' }, durationStr),
                                h('span', { className: 'walkie-history-play' }, isPlaying ? '■' : '▶')
                            ])
                        })
                )
            ])
        ])
    }
    
    function WalkieTalkieApp() {
        var _show = useState(false)
        var show = _show[0]
        var setShow = _show[1]
        var mountRef = useRef(null)
        
        useEffect(function() {
            function fn() {
                globalIsOpen = !globalIsOpen
                setShow(globalIsOpen)
            }
            window.addEventListener('toggle-walkie', fn)
            return function() { window.removeEventListener('toggle-walkie', fn) }
        }, [])
        
        useEffect(function() {
            if (mountRef.current && mountRef.current.parentNode) {
                document.body.removeChild(mountRef.current)
                mountRef.current = null
            }
            if (!show) return
            var container = document.createElement('div')
            container.className = 'walkie-overlay'
            container.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100% !important;height:100% !important;z-index:10 !important;pointer-events:none !important;overflow:hidden !important;margin:0 !important;padding:0 !important;background:transparent !important;'
            document.body.appendChild(container)
            mountRef.current = container
            try {
                var element = h(WalkieTalkiePanel, { 
                    onClose: function() {
                        globalIsOpen = false
                        setShow(false)
                    }
                })
                if (HFS.ReactDOM && HFS.ReactDOM.render) {
                    HFS.ReactDOM.render(element, container)
                } else if (HFS.React && HFS.React.render) {
                    HFS.React.render(element, container)
                }
            } catch {}
            return function() {
                if (mountRef.current && mountRef.current.parentNode) {
                    document.body.removeChild(mountRef.current)
                }
                mountRef.current = null
            }
        }, [show])
        
        return null
    }
    
    keepAlive = getKeepAlive()
    isNoiseEnabled = getNoiseEnabled()
    
    try {
        const saved = localStorage.getItem('walkie-read-history')
        if (saved) {
            const ids = JSON.parse(saved)
            readHistoryIds = new Set(ids)
        }
    } catch (e) {}
    
    if (!keepAlive) {
        signalBars = 0
    } else {
        signalBars = 4
    }
    
    if (keepAlive) {
        setTimeout(function() {
            connect()
            if (isNoiseEnabled) {
                setTimeout(initSQ, 800)
            }
        }, 500)
    }
    
    HFS.onEvent('appendMenuBar', function() {
        return h('button', {
            className: 'menu-bar-walkie-btn',
            onClick: function() {
                window.dispatchEvent(new CustomEvent('toggle-walkie'))
            },
            title: 'Tactical Comms'
        }, [
            h('span', { 'aria-hidden': 'true' }, '₪'),
            h('span', { className: 'btn-label' }, 'Comms')
        ])
    })
    
    HFS.onEvent('footer', function() {
        return h(WalkieTalkieApp)
    })
    
    if (keepAlive) {
        setTimeout(connect, 1000)
    }
}