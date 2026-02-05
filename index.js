const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    jidDecode, 
    proto 
} = require("@whiskeysockets/baileys")

const pino = require("pino")
const { Boom } = require("@hapi/boom")
const readline = require("readline")
const fs = require("fs")
const path = require("path")

// --- KONFIGURASI PATH ---
const configPath = path.join(__dirname, "config.json")
const prefixPath = path.join(__dirname, "data", "prefix.json")
const sessionDir = "session"

// --- CEK FOLDER DATA ---
if (!fs.existsSync(path.join(__dirname, "data"))) {
    fs.mkdirSync(path.join(__dirname, "data"), { recursive: true })
}

// --- FUNGSI INPUT CONSOLE ---
const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(resolve => rl.question(text, ans => {
        rl.close()
        resolve(ans)
    }))
}

// --- GLOBAL PLUGINS STORE ---
const plugins = new Map()

// --- FUNGSI LOAD PLUGINS ---
function loadPlugins(dir = path.join(__dirname, "plugins")) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    
    // Reset plugins map saat reload
    if (dir === path.join(__dirname, "plugins")) plugins.clear()

    const files = fs.readdirSync(dir)
    for (const file of files) {
        const fullPath = path.join(dir, file)
        const stat = fs.statSync(fullPath)

        if (stat.isDirectory()) {
            loadPlugins(fullPath)
        } else if (file.endsWith(".js")) {
            try {
                delete require.cache[require.resolve(fullPath)]
                const plugin = require(fullPath)
                if ((plugin.command || plugin.noPrefix) && typeof plugin.execute === "function") {
                    const pluginName = plugin.name || file.replace(".js", "")
                    plugins.set(pluginName, plugin)
                }
            } catch (e) {
                console.error(`❌ [PLUGIN ERROR] ${file}:`, e.message)
            }
        }
    }
}

// --- DECODE JID ---
const decodeJid = (jid) => {
    if (!jid) return jid
    if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {}
        return decode.user && decode.server && decode.user + "@" + decode.server || jid
    }
    return jid
}

// --- ANTI CRASH SYSTEM ---
process.on('uncaughtException', console.error)
process.on('unhandledRejection', console.error)

// --- MAIN FUNCTION ---
async function startBot() {
    console.clear()
    console.log("🤖 UBOT WA STARTING...")

    // 1. Load Session & Versi WA
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    // 2. LOGIKA INPUT NOMOR HP (FIX PAIRING CODE)
    let phoneNumber = ""
    if (!state.creds.registered) {
        let currentConfig = {}
        try {
            currentConfig = JSON.parse(fs.readFileSync(configPath))
        } catch {
            currentConfig = { pairingText: "UBOT" }
        }
        
        const rawPhone = await question(`📱 Masukkan Nomor WA (628xxx) untuk ${currentConfig.pairingText || "UBOT"}: `)
        phoneNumber = rawPhone.trim().replace(/[^0-9]/g, "")
    }

    // 3. Buat Socket
    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }), 
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60000, 
        getMessage: async (key) => {
            return { conversation: 'hello' }
        }
    })

    // 4. REQUEST PAIRING CODE (Jika nomor sudah diinput)
    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber)
                const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code
                console.log(`\n💬 KODE PAIRING: ${formattedCode}\n`)
            } catch (err) {
                console.error("❌ Gagal request pairing code:", err.message)
                process.exit(1) 
            }
        }, 3000)
    }

    // UPDATE CREDENTIALS
    sock.ev.on("creds.update", saveCreds)

    // CONNECTION UPDATE
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update
        
        if (connection === "open") {
            console.log("✅ Status: Connected!")
            
            loadPlugins()
            let userCount = 0
            try {
                const config = JSON.parse(fs.readFileSync(configPath))
                userCount = Array.isArray(config.user) ? config.user.length : 0
            } catch {}

            console.log(`———————————————`)
            console.log(`👥 User Connect: ${userCount}`)
            console.log(`🔄 Load Plugins: ${plugins.size}`)
            console.log(`———————————————`)
            console.log("🤖 UBot Running...")
        }
        
        if (connection === "close") {
            let reason = new Boom(lastDisconnect?.error)?.output.statusCode
            
            if (reason === DisconnectReason.badSession) {
                console.log(`❌ Bad Session File, Hapus folder ${sessionDir} dan scan ulang.`)
                sock.logout()
            } else if (reason === DisconnectReason.connectionClosed) {
                console.log("⚠️ Connection closed, reconnecting....")
                startBot()
            } else if (reason === DisconnectReason.connectionLost) {
                console.log("⚠️ Connection Lost from Server, reconnecting...")
                startBot()
            } else if (reason === DisconnectReason.connectionReplaced) {
                console.log("⚠️ Connection Replaced, Sesi baru dibuka, tutup sesi ini.")
                sock.logout()
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(`❌ Device Logged Out, Hapus folder ${sessionDir} dan scan ulang.`)
                fs.rmSync(sessionDir, { recursive: true, force: true })
                process.exit()
            } else if (reason === DisconnectReason.restartRequired) {
                console.log("⚠️ Restart Required, Restarting...")
                startBot()
            } else if (reason === DisconnectReason.timedOut) {
                console.log("⚠️ Connection TimedOut, Reconnecting...")
                startBot()
            } else {
                console.log(`⚠️ Unknown DisconnectReason: ${reason}|${connection}`)
                startBot()
            }
        }
    })

    // MESSAGE HANDLER
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return
        const m = messages[0]
        if (!m.message) return
        if (m.key.remoteJid === "status@broadcast") return 

        try {
            let latestConfig = {}
            try { latestConfig = JSON.parse(fs.readFileSync(configPath)) } catch { return }

            const mainOwner = latestConfig.owner ? latestConfig.owner.replace(/[^0-9]/g, '') : ""
            const allowedUsers = Array.isArray(latestConfig.user) ? latestConfig.user.map(num => num.replace(/[^0-9]/g, '')) : []

            let dynamicPrefix = "."
            try {
                if (fs.existsSync(prefixPath)) {
                    const pData = JSON.parse(fs.readFileSync(prefixPath))
                    dynamicPrefix = pData.prefix
                }
            } catch { dynamicPrefix = "." }

            const isMe = m.key.fromMe
            const rawSender = isMe ? sock.user.id : (m.key.participant || m.key.remoteJid)
            const senderJid = decodeJid(rawSender)
            const senderNumber = senderJid.split('@')[0].split(':')[0]
            
            const body = (m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || "")
            
            const prefix = dynamicPrefix
            const isCmd = prefix === "" 
                ? Array.from(plugins.values()).some(p => Array.isArray(p.command) ? p.command.includes(body.trim().split(/ +/)[0].toLowerCase()) : p.command === body.trim().split(/ +/)[0].toLowerCase()) 
                : body.startsWith(prefix)
                
            const command = isCmd 
                ? (prefix === "" ? body.trim().split(/ +/).shift().toLowerCase() : body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase()) 
                : ""
            const args = body.trim().split(/ +/).slice(1)

            const isOwner = isMe || senderNumber === mainOwner || allowedUsers.includes(senderNumber)

            // NO PREFIX
            for (const plugin of plugins.values()) {
                if (plugin.noPrefix && !isCmd) {
                    try {
                        await plugin.execute(sock, m, { args, body, isOwner, prefix, command: "", sender: senderJid })
                    } catch (err) { console.error(`[Plugin Error - NoPrefix] ${plugin.name}:`, err) }
                }
            }

            // WITH COMMAND
            if (isCmd) {
                const plugin = Array.from(plugins.values()).find(p => Array.isArray(p.command) ? p.command.includes(command) : p.command === command)
                if (plugin) {
                    if (plugin.owner && !isOwner) return 
                    try {
                        await plugin.execute(sock, m, { args, body, isOwner, prefix, command, sender: senderJid })
                    } catch (err) { 
                        console.error(`[Plugin Error] ${plugin.name}:`, err)
                        await sock.sendMessage(m.key.remoteJid, { text: "❌ Terjadi kesalahan pada fitur ini." }, { quoted: m })
                    }
                }
            }
        } catch (e) {
            console.error("Message Upsert Error:", e)
        }
    })
}

// --- JALANKAN BOT ---
startBot()
