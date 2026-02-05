// --- MAIN FUNCTION ---
async function startBot() {
    console.clear()
    console.log("🤖 UBOT WA STARTING...")

    // 1. Load Session & Versi WA
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    // 2. LOGIKA INPUT NOMOR HP (DIPINDAHKAN KE ATAS)
    // Kita cek dulu status registered sebelum membuat socket
    let phoneNumber = ""
    if (!state.creds.registered) {
        let currentConfig = {}
        try {
            currentConfig = JSON.parse(fs.readFileSync(configPath))
        } catch {
            currentConfig = { pairingText: "UBOT" }
        }
        
        // Tanya nomor dulu, baru connect
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
        // Browser yang stabil untuk Pairing Code
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        generateHighQualityLinkPreview: true,
        // Tambahkan timeout connect lebih lama
        connectTimeoutMs: 60000, 
        getMessage: async (key) => {
            return { conversation: 'hello' }
        }
    })

    // 4. REQUEST PAIRING CODE (JIKA BELUM REGISTERED)
    if (!sock.authState.creds.registered && phoneNumber) {
        setTimeout(async () => {
            try {
                // Request code
                const code = await sock.requestPairingCode(phoneNumber)
                // Format kode agar mudah dibaca (ABC-DEF)
                const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code
                console.log(`\n💬 KODE PAIRING: ${formattedCode}\n`)
            } catch (err) {
                console.error("❌ Gagal request pairing code:", err.message)
                // Jika gagal, restart agar user bisa coba lagi
                process.exit(1) 
            }
        }, 3000) // Tunggu 3 detik agar socket benar-benar "ready" untuk request
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
        // ... (Kode handler kamu tetap sama seperti sebelumnya) ...
        // Copy paste isi handler message kamu di sini
        if (type !== "notify") return
        const m = messages[0]
        if (!m.message) return
        if (m.key.remoteJid === "status@broadcast") return 

        try {
            // CONFIG LOADER 
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

            for (const plugin of plugins.values()) {
                if (plugin.noPrefix && !isCmd) {
                    try {
                        await plugin.execute(sock, m, { args, body, isOwner, prefix, command: "", sender: senderJid })
                    } catch (err) { console.error(`[Plugin Error - NoPrefix] ${plugin.name}:`, err) }
                }
            }

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