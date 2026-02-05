const { downloadContentFromMessage } = require("@whiskeysockets/baileys")

module.exports = {
    name: "RVO Premium",
    command: ["rvo", "readviewonce"],
    noPrefix: false,
    execute: async (sock, m, { args, sender }) => {
        try {
            // 1. Ambil data pesan yang di-reply
            const msg = m.message?.extendedTextMessage?.contextInfo
            const quoted = msg?.quotedMessage

            // Validasi apakah ada reply
            if (!quoted) {
                return await sock.sendMessage(m.key.remoteJid, { 
                    text: "⚠️ *System Alert:* Mohon reply pesan View Once yang ingin dibuka!" 
                }, { quoted: m })
            }

            // 2. Berikan reaksi 'Loading' agar user tahu bot sedang bekerja
            await sock.sendMessage(m.key.remoteJid, { react: { text: "⏳", key: m.key } })

            // 3. Deteksi View Once (V1 & V2)
            const viewOnceMsg = quoted.viewOnceMessage?.message || quoted.viewOnceMessageV2?.message || quoted
            const isImage = viewOnceMsg.imageMessage
            const isVideo = viewOnceMsg.videoMessage

            if (!isImage && !isVideo) {
                await sock.sendMessage(m.key.remoteJid, { react: { text: "❌", key: m.key } })
                return await sock.sendMessage(m.key.remoteJid, { 
                    text: "⚠️ *Error:* Pesan yang kamu reply bukan gambar/video View Once." 
                }, { quoted: m })
            }

            // 4. Download Media
            const mediaType = isImage ? 'image' : 'video'
            const mediaMessage = isImage || isVideo
            const stream = await downloadContentFromMessage(mediaMessage, mediaType)
            let buffer = Buffer.from([])
            
            for await(const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk])
            }

            // 5. Ambil Info Pengirim Asli (Target yang mengirim View Once)
            const participant = msg.participant || m.key.participant || m.key.remoteJid
            const targetName = "@" + participant.split('@')[0]

            // 6. Buat Caption Premium
            const caption = `🔓 *RVO UNLOCKED SYSTEM*\n` +
                            `━━━━━━━━━━━━━━━━━━━\n` +
                            `👤 *From:* ${targetName}\n` +
                            `📅 *Date:* ${new Date().toLocaleString()}\n` +
                            `📁 *Type:* ${mediaType.toUpperCase()}\n` +
                            `━━━━━━━━━━━━━━━━━━━\n` +
                            `_Media ini diamankan dan dikirim ke Private Chat._`

            // 7. KIRIM KE PRIVATE CHAT (JAPRI)
            // Menggunakan 'sender' sebagai tujuan pesan, bukan m.key.remoteJid
            if (isImage) {
                await sock.sendMessage(sender, { 
                    image: buffer, 
                    caption: caption,
                    mentions: [participant] // Agar tag nama berfungsi
                })
            } else if (isVideo) {
                await sock.sendMessage(sender, { 
                    video: buffer, 
                    caption: caption,
                    mentions: [participant] 
                })
            }

            // 8. Konfirmasi Sukses di Grup/Chat Asal
            await sock.sendMessage(m.key.remoteJid, { react: { text: "✅", key: m.key } })
            // Opsional: Kirim notif teks pendek di grup
            if (m.key.remoteJid.endsWith('@g.us')) {
                await sock.sendMessage(m.key.remoteJid, { 
                    text: "✅ *Success!* Media telah dikirim ke Private Chat (PC) kamu." 
                }, { quoted: m })
            }

        } catch (e) {
            console.error("RVO Error:", e)
            await sock.sendMessage(m.key.remoteJid, { react: { text: "❌", key: m.key } })
            await sock.sendMessage(m.key.remoteJid, { 
                text: "❌ *System Failed:* Gagal mengambil media. Mungkin pesan sudah kadaluarsa/dihapus server." 
            }, { quoted: m })
        }
    }
}
