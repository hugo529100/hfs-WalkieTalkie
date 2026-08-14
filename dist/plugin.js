exports.version = 2.1
exports.description = "Tactical Communications System - Real-time voice broadcast with PTT"
exports.repo = "Hug3O/WalkieTalkie"
exports.apiRequired = 8.87
exports.frontend_js = ['main.js']
exports.frontend_css = ['style.css']

exports.config = {
    wsPort: {
        type: 'number',
        defaultValue: 8123,
        label: 'Signal Port',
        helperText: 'Port for signal connections (must match P2P-remote-ctrl)'
    },
    debugMode: {
        type: 'boolean',
        defaultValue: false,
        label: 'Debug Mode',
        helperText: 'Enable diagnostic logging'
    },
    maxHistoryRecords: {
        type: 'number',
        label: 'Max Log Records',
        defaultValue: 30,
        helperText: 'Number of transmissions to keep in log (0 = disabled). Also controls live file cleanup.'
    },
    minRecordDuration: {
        type: 'number',
        label: 'Minimum Record Duration (ms)',
        defaultValue: 2000,
        min: 500,
        max: 10000,
        step: 100,
        helperText: 'Minimum duration in milliseconds for a transmission to be saved. Shorter transmissions are ignored.'
    },
    broadcastTimeout: {
        type: 'number',
        label: 'Transmission Timeout (seconds)',
        defaultValue: 60,
        helperText: 'Auto-release transmission after this time if no activity'
    },
    allowAnonymous: {
        type: 'boolean',
        label: 'Allow Anonymous Transmission',
        defaultValue: false,
        helperText: 'Allow unauthenticated units to transmit'
    },
    liveBufferDelay: {
        type: 'number',
        label: 'Signal Buffer Delay (seconds)',
        defaultValue: 2,
        helperText: 'Seconds of delay for signal buffer (2-5 seconds recommended)',
        min: 1,
        max: 10
    },
    microphoneGain: {
        type: 'number',
        label: 'Mic Gain (dB)',
        defaultValue: 6,
        min: 0,
        max: 30,
        helperText: 'Amplify microphone input. Higher values increase volume but may cause distortion. Recommended: 0-12dB'
    },
    startSound: {
        type: 'vfs_path',
        folders: false,
        files: true,
        fileMask: '*.mp3;*.wav;*.ogg',
        defaultValue: '',
        label: 'Transmit Start Tone',
        helperText: 'Tone played when starting transmission. Leave empty for default (start.mp3).'
    },
    endSound: {
        type: 'vfs_path',
        folders: false,
        files: true,
        fileMask: '*.mp3;*.wav;*.ogg',
        defaultValue: '',
        label: 'Transmit End Tone',
        helperText: 'Tone played when ending transmission. Leave empty for default (end.mp3).'
    },
    noiseSound: {
        type: 'vfs_path',
        folders: false,
        files: true,
        fileMask: '*.mp3;*.wav;*.ogg',
        defaultValue: '',
        label: 'Background Noise (SQ)',
        helperText: 'Background noise for squelch. Leave empty for default (noise.mp3).'
    }
}

exports.init = async api => {
    const fsPromises = api.require('fs/promises')
    const fsSync = api.require('fs')
    const path = api.require('path')
    const net = api.require('net')
    const { getCurrentUsername } = api.require('./auth')
    
    const { createWriteStream, existsSync, createReadStream, readdirSync, unlinkSync, statSync, mkdirSync } = fsSync
    const fs = fsPromises
    
    const storage = api.storageDir
    const audioDir = path.join(storage, 'walkie_audio')
    const historyFile = path.join(storage, 'walkie_history.json')
    const liveDir = path.join(storage, 'walkie_live')
    
    try {
        if (existsSync(liveDir)) {
            const files = readdirSync(liveDir)
            for (const file of files) {
                try {
                    unlinkSync(path.join(liveDir, file))
                } catch (e) {}
            }
        } else {
            mkdirSync(liveDir, { recursive: true })
        }
    } catch (e) {}
    
    try {
        await fs.mkdir(audioDir, { recursive: true })
        await fs.mkdir(liveDir, { recursive: true })
    } catch (e) {}
    
    const WS_PORT = api.getConfig('wsPort') || 8123
    const DEBUG = api.getConfig('debugMode') || false
    const MAX_HISTORY = api.getConfig('maxHistoryRecords') || 30
    const MIN_RECORD_DURATION = api.getConfig('minRecordDuration') || 2000
    const LIVE_BUFFER_DELAY = api.getConfig('liveBufferDelay') || 2
    
    let currentBroadcaster = null
    let broadcastTimeoutTimer = null
    let isWsPortInUse = false
    
    function getPluginBasePath() {
        try {
            if (typeof __dirname !== 'undefined') return __dirname
        } catch {}
        try {
            if (typeof module !== 'undefined' && module.filename) {
                return path.dirname(module.filename)
            }
        } catch {}
        return null
    }
    
    const pluginBasePath = getPluginBasePath()
    
    function getSoundFilePath(filename, configKey) {
        const configPath = api.getConfig(configKey) || ''
        if (configPath && configPath.trim() !== '' && existsSync(configPath)) {
            return configPath
        }
        if (pluginBasePath) {
            const publicPath = path.join(pluginBasePath, 'public', filename)
            if (existsSync(publicPath)) return publicPath
            const rootPath = path.join(pluginBasePath, filename)
            if (existsSync(rootPath)) return rootPath
        }
        return null
    }
    
    function getNoiseFilePath() {
        return getSoundFilePath('noise.mp3', 'noiseSound')
    }
    
    function getStartSoundPath() {
        return getSoundFilePath('start.mp3', 'startSound')
    }
    
    function getEndSoundPath() {
        return getSoundFilePath('end.mp3', 'endSound')
    }
    
    let liveSession = null
    let liveWriteStream = null
    let liveFilePath = null
    let liveFileSize = 0
    let liveStartTime = null
    let liveChunkCount = 0
    const LIVE_SESSION_PREFIX = 'live_'
    const LIVE_FILE_EXT = '.webm'
    
    let sqEnabled = true
    let sqPaused = false
    let sqNoiseDuration = 0
    let sqPlaybackStartTime = 0
    let sqBroadcastInterval = null
    
    let wsClients = new Set()
    
    function getNoiseDuration() {
        const noiseFile = getNoiseFilePath()
        if (noiseFile && existsSync(noiseFile)) {
            try {
                const stat = statSync(noiseFile)
                return 0
            } catch (e) {
                return 0
            }
        }
        return 0
    }
    
    function cleanupLiveFiles() {
        if (MAX_HISTORY <= 0) return
        try {
            const files = readdirSync(liveDir)
                .filter(f => f.startsWith(LIVE_SESSION_PREFIX) && f.endsWith(LIVE_FILE_EXT))
                .map(f => {
                    const fullPath = path.join(liveDir, f)
                    const stat = statSync(fullPath)
                    return { name: f, path: fullPath, mtime: stat.mtimeMs }
                })
                .sort((a, b) => b.mtime - a.mtime)
            
            if (files.length > MAX_HISTORY) {
                const toRemove = files.slice(MAX_HISTORY)
                for (const file of toRemove) {
                    try {
                        unlinkSync(file.path)
                        if (DEBUG) api.log('[Comms] Cleaned up:', file.name)
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }
    
    function startLiveSession(username, ip) {
        if (liveSession) endLiveSession()
        cleanupLiveFiles()
        
        const now = new Date()
        const timestamp = 
            String(now.getFullYear()) +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0') +
            '_' +
            String(now.getHours()).padStart(2, '0') +
            String(now.getMinutes()).padStart(2, '0') +
            String(now.getSeconds()).padStart(2, '0')
        
        const fileName = LIVE_SESSION_PREFIX + timestamp + '_' + Date.now() + LIVE_FILE_EXT
        liveFilePath = path.join(liveDir, fileName)
        liveFileSize = 0
        liveChunkCount = 0
        liveStartTime = Date.now()
        liveWriteStream = createWriteStream(liveFilePath, { flags: 'a' })
        
        liveSession = {
            sessionId: Date.now() + '-' + Math.random().toString(36).slice(2),
            filePath: fileName,
            fullPath: liveFilePath,
            username: username,
            ip: ip,
            startTime: liveStartTime,
            chunkCount: 0,
            bufferDelay: LIVE_BUFFER_DELAY
        }
        
        if (DEBUG) api.log('[Comms] Live session started:', liveSession.sessionId)
        return liveSession
    }
    
    function appendToLiveStream(base64Data) {
        return new Promise((resolve) => {
            if (!liveWriteStream || !liveSession) { resolve(false); return }
            try {
                const binaryString = atob(base64Data)
                const bytes = new Uint8Array(binaryString.length)
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i)
                }
                liveWriteStream.write(Buffer.from(bytes), (err) => {
                    if (err) { resolve(false) }
                    else {
                        liveFileSize += bytes.length
                        liveChunkCount++
                        if (liveSession) liveSession.chunkCount = liveChunkCount
                        resolve(true)
                    }
                })
            } catch (e) { resolve(false) }
        })
    }
    
    function endLiveSession() {
        return new Promise((resolve) => {
            if (liveWriteStream) {
                liveWriteStream.end(() => {
                    liveWriteStream = null
                    if (DEBUG) api.log('[Comms] Live session ended:', liveSession?.sessionId)
                    liveSession = null
                    liveFilePath = null
                    liveFileSize = 0
                    liveStartTime = null
                    cleanupLiveFiles()
                    resolve()
                })
            } else {
                liveSession = null
                liveFilePath = null
                liveFileSize = 0
                liveStartTime = null
                cleanupLiveFiles()
                resolve()
            }
        })
    }
    
    function getLiveSessionInfo() {
        if (!liveSession || !liveFilePath) return null
        return {
            sessionId: liveSession.sessionId,
            filePath: path.basename(liveFilePath),
            fileUrl: '/~/api/walkie/live-stream?path=' + encodeURIComponent(path.basename(liveFilePath)),
            startTime: liveStartTime,
            username: liveSession.username,
            chunkCount: liveChunkCount,
            fileSize: liveFileSize,
            duration: liveStartTime ? (Date.now() - liveStartTime) / 1000 : 0,
            bufferDelay: LIVE_BUFFER_DELAY
        }
    }
    
    function initSQ() {
        sqPlaybackStartTime = Date.now()
        sqNoiseDuration = getNoiseDuration()
        sqPaused = false
        if (DEBUG) api.log('[Comms] SQ initialized, duration:', sqNoiseDuration + 'ms')
    }
    
    function startSQBroadcast() {
        stopSQBroadcast()
        
        sqBroadcastInterval = setInterval(() => {
            if (!sqEnabled || wsClients.size === 0) return
            
            const now = Date.now()
            const elapsed = now - sqPlaybackStartTime
            const currentPosition = sqNoiseDuration > 0 ? (elapsed % sqNoiseDuration) : 0
            
            const msg = JSON.stringify({
                type: 'sqProgress',
                playbackStartTime: sqPlaybackStartTime,
                totalDuration: sqNoiseDuration,
                currentPosition: currentPosition,
                serverTime: now,
                enabled: sqEnabled,
                isPlaying: sqEnabled && !sqPaused
            })
            
            for (const client of wsClients) {
                if (client.readyState === 1) {
                    try {
                        client.send(msg)
                    } catch (e) {}
                }
            }
        }, 50)
    }
    
    function stopSQBroadcast() {
        if (sqBroadcastInterval) {
            clearInterval(sqBroadcastInterval)
            sqBroadcastInterval = null
        }
    }
    
    function setSQEnabled(enabled) {
        sqEnabled = enabled
        if (DEBUG) api.log('[Comms] SQ enabled:', enabled)
        if (enabled) {
            sqPlaybackStartTime = Date.now()
            sqPaused = false
        } else {
            sqPaused = true
        }
        const msg = JSON.stringify({
            type: 'sqStateChange',
            enabled: enabled,
            playbackStartTime: sqPlaybackStartTime,
            totalDuration: sqNoiseDuration,
            isPlaying: enabled && !sqPaused
        })
        for (const client of wsClients) {
            if (client.readyState === 1) {
                try { client.send(msg) } catch (e) {}
            }
        }
    }
    
    function handleWebSocket(ws) {
        wsClients.add(ws)
        
        if (DEBUG) api.log('[Comms] WebSocket client connected, Total:', wsClients.size)
        
        try {
            ws.send(JSON.stringify({
                type: 'sqInit',
                enabled: sqEnabled,
                playbackStartTime: sqPlaybackStartTime,
                totalDuration: sqNoiseDuration,
                serverTime: Date.now(),
                isPlaying: sqEnabled && !sqPaused
            }))
        } catch (e) {}
        
        ws.on('message', function(data) {
            try {
                const msg = JSON.parse(data)
                
                if (msg.type === 'ping') {
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: msg.timestamp || Date.now(),
                        serverTime: Date.now()
                    }))
                    return
                }
                
                if (msg.type === 'identify') {
                    ws.username = msg.username || 'Anonymous'
                    ws.clientId = msg.clientId || Date.now()
                } else if (msg.type === 'broadcastEnd') {
                    const duration = msg.duration || 0
                    const minDurationSec = MIN_RECORD_DURATION / 1000
                    if (duration < minDurationSec) {
                        const shortMsg = JSON.stringify({
                            type: 'broadcastEnd',
                            broadcaster: msg.broadcaster || 'Unit',
                            timestamp: msg.timestamp || Date.now(),
                            duration: duration,
                            ignored: true,
                            reason: 'too short',
                            minRequired: MIN_RECORD_DURATION
                        })
                        for (const client of wsClients) {
                            if (client.readyState === 1 && client !== ws) {
                                try { client.send(shortMsg) } catch (e) {}
                            }
                        }
                    }
                }
            } catch (e) {}
        })
        
        ws.on('close', function() {
            wsClients.delete(ws)
            if (DEBUG) api.log('[Comms] WebSocket client disconnected, Remaining:', wsClients.size)
        })
        
        ws.on('error', function() {
            wsClients.delete(ws)
        })
    }
    
    async function saveAudioFile(base64Data, mimeType) {
        const now = new Date()
        const month = String(now.getMonth() + 1).padStart(2, '0')
        const day = String(now.getDate()).padStart(2, '0')
        const hour = String(now.getHours()).padStart(2, '0')
        const min = String(now.getMinutes()).padStart(2, '0')
        const sec = String(now.getSeconds()).padStart(2, '0')
        const ms = String(now.getMilliseconds()).padStart(3, '0')
        
        const ext = mimeType && mimeType.includes('webm') ? 'webm' : 'wav'
        const fileName = month + '-' + day + '-' + hour + '-' + min + '-' + sec + '-' + ms + '.' + ext
        const filePath = path.join(audioDir, fileName)
        
        const binaryString = atob(base64Data)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
        }
        await fs.writeFile(filePath, Buffer.from(bytes))
        
        const displayName = month + '-' + day + ' ' + hour + ':' + min + ':' + sec
        return {
            fileId: fileName,
            fileName: fileName,
            displayName: displayName,
            filePath: fileName,
            size: bytes.length,
            timestamp: now.getTime()
        }
    }
    
    async function loadHistory() {
        try {
            const data = await fs.readFile(historyFile, 'utf-8')
            return JSON.parse(data)
        } catch { return [] }
    }
    
    async function saveHistory(records) {
        await fs.writeFile(historyFile, JSON.stringify(records, null, 2))
    }
    
    async function trimHistory() {
        const records = await loadHistory()
        if (records.length <= MAX_HISTORY) return
        const sorted = records.slice().sort((a, b) => a.timestamp - b.timestamp)
        const toRemove = sorted.slice(0, sorted.length - MAX_HISTORY)
        for (const record of toRemove) {
            try {
                await fs.unlink(path.join(audioDir, record.filePath)).catch(() => {})
            } catch (e) {}
        }
        const remaining = records.filter(r => !toRemove.includes(r))
        await saveHistory(remaining)
    }
    
    async function addHistoryRecord(username, ip, fileInfo, duration) {
        const records = await loadHistory()
        const record = {
            id: fileInfo.fileId,
            username: username || 'Anonymous',
            ip: ip || 'unknown',
            timestamp: fileInfo.timestamp || Date.now(),
            time: fileInfo.displayName,
            filePath: fileInfo.filePath,
            size: fileInfo.size,
            duration: duration || 0
        }
        records.push(record)
        await saveHistory(records)
        await trimHistory()
        return record
    }
    
    function checkPortInUse(port) {
        return new Promise((resolve) => {
            const server = net.createServer()
            server.once('error', (err) => {
                resolve(err.code === 'EADDRINUSE')
            })
            server.once('listening', () => {
                server.close()
                resolve(false)
            })
            server.listen(port, '127.0.0.1')
        })
    }
    
    async function handleHistory(ctx) {
        const records = await loadHistory()
        const sorted = records.slice().sort((a, b) => b.timestamp - a.timestamp)
        ctx.body = { records: sorted.slice(0, MAX_HISTORY), total: records.length }
        ctx.status = 200
    }
    
    async function handleSaveAudio(ctx) {
        const username = getCurrentUsername(ctx) || 'Anonymous'
        const ip = ctx.ip || ctx.request?.ip || 'unknown'
        let body
        try {
            body = ctx.request?.body || ctx.state?.params || {}
            if (typeof body === 'string') body = JSON.parse(body)
        } catch (e) { body = {} }
        const { audio, duration = 0, mimeType = 'audio/webm', startTime, endTime } = body
        if (!audio) {
            ctx.status = 400
            ctx.body = { error: 'No audio data' }
            return
        }
        
        const finalDuration = duration || (endTime && startTime ? (endTime - startTime) / 1000 : 0)
        const minDurationSec = MIN_RECORD_DURATION / 1000
        if (finalDuration < minDurationSec) {
            ctx.status = 400
            ctx.body = { 
                error: 'Recording too short (minimum ' + MIN_RECORD_DURATION + 'ms)', 
                duration: finalDuration,
                minRequired: MIN_RECORD_DURATION
            }
            return
        }
        
        try {
            const fileInfo = await saveAudioFile(audio, mimeType)
            const record = await addHistoryRecord(username, ip, fileInfo, finalDuration)
            ctx.body = { success: true, record: record }
            ctx.status = 200
        } catch (e) {
            ctx.status = 500
            ctx.body = { error: 'Failed to save audio' }
        }
    }
    
    async function handleGetAudio(ctx) {
        const filePath = ctx.query.path
        if (!filePath) { ctx.status = 400; return }
        const normalized = path.normalize(filePath)
        if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) {
            ctx.status = 403; return
        }
        const fullPath = path.join(audioDir, normalized)
        try {
            const data = await fs.readFile(fullPath)
            ctx.body = data
            ctx.status = 200
            ctx.type = normalized.endsWith('.webm') ? 'audio/webm' : 'audio/wav'
        } catch (e) {
            ctx.status = 404
        }
    }
    
    async function handleStatus(ctx) {
        const liveInfo = getLiveSessionInfo()
        ctx.body = {
            broadcasting: !!currentBroadcaster,
            broadcaster: currentBroadcaster ? { username: currentBroadcaster.username, ip: currentBroadcaster.ip } : null,
            wsPort: WS_PORT,
            wsPortInUse: isWsPortInUse,
            live: liveInfo,
            sqEnabled: sqEnabled,
            sqPaused: sqPaused,
            sqPlaybackStartTime: sqPlaybackStartTime,
            sqTotalDuration: sqNoiseDuration,
            sqClients: wsClients.size,
            maxHistory: MAX_HISTORY,
            minRecordDuration: MIN_RECORD_DURATION,
            serverTime: Date.now()
        }
        ctx.status = 200
    }
    
    async function handleClearHistory(ctx) {
        const username = getCurrentUsername(ctx)
        if (username !== 'admin') { ctx.status = 403; return }
        await saveHistory([])
        try {
            const files = await fs.readdir(audioDir)
            for (const file of files) {
                await fs.unlink(path.join(audioDir, file)).catch(() => {})
            }
        } catch (e) {}
        ctx.body = { ok: true }
        ctx.status = 200
    }
    
    async function handleLiveStart(ctx) {
        const username = getCurrentUsername(ctx) || 'Anonymous'
        const ip = ctx.ip || ctx.request?.ip || 'unknown'
        if (liveSession) await endLiveSession()
        const session = startLiveSession(username, ip)
        ctx.body = {
            success: true,
            session: {
                sessionId: session.sessionId,
                filePath: path.basename(liveFilePath),
                fileUrl: '/~/api/walkie/live-stream?path=' + encodeURIComponent(path.basename(liveFilePath)),
                bufferDelay: LIVE_BUFFER_DELAY
            }
        }
        ctx.status = 200
    }
    
    async function handleLiveEnd(ctx) {
        if (liveSession) await endLiveSession()
        ctx.body = { success: true }
        ctx.status = 200
    }
    
    async function handleLiveAppend(ctx) {
        if (!liveSession) {
            ctx.status = 404
            ctx.body = { error: 'No active live session' }
            return
        }
        let body
        try {
            body = ctx.request?.body || ctx.state?.params || {}
            if (typeof body === 'string') body = JSON.parse(body)
        } catch (e) { body = {} }
        const { audio, sessionId } = body
        if (!audio) { ctx.status = 400; ctx.body = { error: 'No audio data' }; return }
        if (sessionId && liveSession.sessionId !== sessionId) {
            ctx.status = 403
            ctx.body = { error: 'Invalid session' }
            return
        }
        try {
            const success = await appendToLiveStream(audio)
            if (success) {
                ctx.body = { success: true, chunk: liveChunkCount, fileSize: liveFileSize }
                ctx.status = 200
            } else {
                ctx.status = 500
                ctx.body = { error: 'Failed to write audio data' }
            }
        } catch (e) {
            ctx.status = 500
            ctx.body = { error: 'Internal error' }
        }
    }
    
    async function handleLiveInfo(ctx) {
        const liveInfo = getLiveSessionInfo()
        if (!liveInfo) { ctx.status = 404; ctx.body = { error: 'No active live session' }; return }
        ctx.body = liveInfo
        ctx.status = 200
    }
    
    async function handleLiveStream(ctx) {
        const filePath = ctx.query.path
        if (!filePath) {
            ctx.status = 400
            ctx.body = { error: 'Missing path parameter' }
            return
        }
        const cleanPath = filePath.split('?')[0]
        const normalized = path.normalize(cleanPath)
        if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) {
            ctx.status = 403
            ctx.body = { error: 'Invalid path' }
            return
        }
        const fullPath = path.join(liveDir, normalized)
        if (!existsSync(fullPath)) {
            ctx.status = 404
            ctx.body = { error: 'File not found' }
            return
        }
        try {
            const stat = await fs.stat(fullPath)
            const fileSize = stat.size
            if (fileSize === 0) {
                ctx.status = 404
                ctx.body = { error: 'File is empty' }
                return
            }
            const range = ctx.headers.range
            let start = 0, end = fileSize - 1
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-')
                start = parseInt(parts[0], 10)
                if (parts[1]) end = parseInt(parts[1], 10)
                if (start < 0) start = 0
                if (end >= fileSize) end = fileSize - 1
                if (start > end) {
                    ctx.status = 416
                    ctx.set('Content-Range', `bytes */${fileSize}`)
                    return
                }
            }
            const chunkSize = end - start + 1
            ctx.status = range ? 206 : 200
            ctx.type = 'audio/webm'
            ctx.set('Content-Range', `bytes ${start}-${end}/${fileSize}`)
            ctx.set('Content-Length', chunkSize)
            ctx.set('Accept-Ranges', 'bytes')
            ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate')
            const stream = createReadStream(fullPath, { start, end })
            ctx.body = stream
        } catch (e) {
            if (DEBUG) api.log('[Comms] Live stream error:', e)
            ctx.status = 500
            ctx.body = { error: 'Internal server error' }
        }
    }
    
    async function handleLiveSize(ctx) {
        const filePath = ctx.query.path
        if (!filePath) { ctx.status = 400; return }
        const normalized = path.normalize(filePath)
        if (normalized.includes('..')) { ctx.status = 403; return }
        const fullPath = path.join(liveDir, normalized)
        try {
            const stat = await fs.stat(fullPath)
            ctx.body = { size: stat.size, mtime: stat.mtimeMs, isLive: normalized.startsWith(LIVE_SESSION_PREFIX) }
            ctx.status = 200
        } catch (e) {
            ctx.status = 404
            ctx.body = { error: 'File not found' }
        }
    }
    
    async function handleLiveCleanup(ctx) {
        const username = getCurrentUsername(ctx)
        if (username !== 'admin') { ctx.status = 403; return }
        try {
            const files = await fs.readdir(liveDir)
            for (const file of files) {
                if (file.startsWith(LIVE_SESSION_PREFIX)) {
                    await fs.unlink(path.join(liveDir, file)).catch(() => {})
                }
            }
            ctx.body = { success: true }
            ctx.status = 200
        } catch (e) {
            ctx.status = 500
            ctx.body = { error: 'Cleanup failed' }
        }
    }
    
    async function handleSQStatus(ctx) {
        ctx.body = {
            enabled: sqEnabled,
            paused: sqPaused,
            playbackStartTime: sqPlaybackStartTime,
            totalDuration: sqNoiseDuration,
            clients: wsClients.size,
            serverTime: Date.now()
        }
        ctx.status = 200
    }
    
    async function handleSQSetEnabled(ctx) {
        let body
        try {
            body = ctx.request?.body || ctx.state?.params || {}
            if (typeof body === 'string') body = JSON.parse(body)
        } catch (e) { body = {} }
        const { enabled } = body
        if (typeof enabled !== 'boolean') {
            ctx.status = 400
            ctx.body = { error: 'enabled must be boolean' }
            return
        }
        setSQEnabled(enabled)
        ctx.body = { success: true, enabled: sqEnabled, paused: sqPaused }
        ctx.status = 200
    }
    
    await new Promise(resolve => setTimeout(resolve, 1500))
    isWsPortInUse = await checkPortInUse(WS_PORT)
    
    initSQ()
    
    if (DEBUG) {
        api.log('[Comms] Port ' + WS_PORT + ': ' + (isWsPortInUse ? 'in use' : 'available'))
        api.log('[Comms] Plugin path:', pluginBasePath)
        api.log('[Comms] Noise file:', getNoiseFilePath() || 'NOT FOUND')
        api.log('[Comms] SQ duration:', sqNoiseDuration + 'ms')
        api.log('[Comms] Live dir cleaned on startup')
        api.log('[Comms] Min record duration:', MIN_RECORD_DURATION + 'ms')
    }
    
    setTimeout(() => {
        if (sqEnabled) startSQBroadcast()
    }, 2000)
    
    return {
        async middleware(ctx) {
            const p = ctx.path
            const apiPrefix = '/~/api/walkie/'
            
            if (p === '/~/api/walkie/ws' && ctx.method === 'GET') {
                if (ctx.ws) {
                    handleWebSocket(ctx.ws)
                    return
                }
                ctx.status = 400
                ctx.body = { error: 'WebSocket connection required' }
                return
            }
            
            if (!p.startsWith(apiPrefix)) return
            
            const method = ctx.method.toUpperCase()
            const pathWithoutPrefix = p.substring(apiPrefix.length - 1)
            
            if (pathWithoutPrefix === '/history' && method === 'GET') { await handleHistory(ctx); return }
            if (pathWithoutPrefix === '/save-audio' && method === 'POST') { await handleSaveAudio(ctx); return }
            if (pathWithoutPrefix === '/audio' && method === 'GET') { await handleGetAudio(ctx); return }
            if (pathWithoutPrefix === '/status' && method === 'GET') { await handleStatus(ctx); return }
            if (pathWithoutPrefix === '/history' && method === 'DELETE') { await handleClearHistory(ctx); return }
            
            if (pathWithoutPrefix === '/live-start' && method === 'POST') { await handleLiveStart(ctx); return }
            if (pathWithoutPrefix === '/live-end' && method === 'POST') { await handleLiveEnd(ctx); return }
            if (pathWithoutPrefix === '/live-append' && method === 'POST') { await handleLiveAppend(ctx); return }
            if (pathWithoutPrefix === '/live-info' && method === 'GET') { await handleLiveInfo(ctx); return }
            if (pathWithoutPrefix === '/live-stream' && method === 'GET') { await handleLiveStream(ctx); return }
            if (pathWithoutPrefix === '/live-size' && method === 'GET') { await handleLiveSize(ctx); return }
            if (pathWithoutPrefix === '/live-cleanup' && method === 'POST') { await handleLiveCleanup(ctx); return }
            
            if (pathWithoutPrefix === '/sq-status' && method === 'GET') { await handleSQStatus(ctx); return }
            if (pathWithoutPrefix === '/sq-enabled' && method === 'POST') { await handleSQSetEnabled(ctx); return }
            
            ctx.status = 404
            ctx.body = { error: 'Not found' }
        },
        
        unload: function() {
            if (broadcastTimeoutTimer) clearTimeout(broadcastTimeoutTimer)
            if (liveWriteStream) {
                try { liveWriteStream.end() } catch (e) {}
                liveWriteStream = null
            }
            liveSession = null
            currentBroadcaster = null
            stopSQBroadcast()
            wsClients.clear()
        }
    }
}