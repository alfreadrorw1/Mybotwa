const axios = require('axios')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const crypto = require('crypto')

module.exports = {
    name: "Quote Chat Fix",
    command: ["qc", "quote"],
    noPrefix: false,
    execute: async (sock, m, { args, sender }) => {
        try {
            // 1. Ambil teks
            let text
            if (args.length >= 1) {
                text = args.join(" ")
            } else if (m.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation) {
                text = m.message.extendedTextMessage.contextInfo.quotedMessage.conversation
            } else {
                return await sock.sendMessage(m.key.remoteJid, { text: "⚠️ Masukkan teks atau reply chat!" }, { quoted: m })
            }

            // Indikator Loading
            await sock.sendMessage(m.key.remoteJid, { react: { text: "🎨", key: m.key } })

            // 2. Ambil Foto Profil & Nama
            let ppUser
            try {
                ppUser = await sock.profilePictureUrl(sender, 'image')
            } catch {
                ppUser = 'https://i.ibb.co/Tq7d7x5/default-avatar.png'
            }
            const pushName = m.pushName || "User"

            // 3. Konfigurasi API QC (Dark Purple Premium)
            const obj = {
                "type": "quote",
                "format": "png",
                "backgroundColor": "#1b1429", 
                "width": 512,
                "height": 768,
                "scale": 2,
                "messages": [{
                    "entities": [],
                    "avatar": true,
                    "from": { "id": 1, "name": pushName, "photo": { "url": ppUser } },
                    "text": text,
                    "replyMessage": {}
                }]
            }

            // 4. Request Gambar
            const response = await axios.post('https://qc.botcahx.eu.org/generate', obj, { 
                headers: { 'Content-Type': 'application/json' } 
            })
            const buffer = Buffer.from(response.data.result.image, 'base64')

            // 5. PROSES FFMPEG (ANTI GEPENG)
            const getRandomFile = (ext) => path.join(__dirname, `../temp_${crypto.randomBytes(3).toString('hex')}${ext}`)
            const tempImg = getRandomFile('.png')
            const tempWebp = getRandomFile('.webp')
            
            fs.writeFileSync(tempImg, buffer)

            // Filter complex untuk scale proportional + padding transparent
            // Ini yang bikin gambar TIDAK GEPENG
            const ffmpegCommand = `ffmpeg -i "${tempImg}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -c:v libwebp -preset default -loop 0 -an -vsync 0 "${tempWebp}"`

            exec(ffmpegCommand, async (err) => {
                if (fs.existsSync(tempImg)) fs.unlinkSync(tempImg)

                if (err) {
                    console.error("FFmpeg Error:", err)
                    return await sock.sendMessage(m.key.remoteJid, { text: "❌ Gagal konversi stiker." }, { quoted: m })
                }

                // 6. TAMBAHKAN METADATA (Created by Alfread)
                // Kita baca file WebP hasil FFmpeg
                let webpBuffer = fs.readFileSync(tempWebp)
                
                // Panggil fungsi penambah Exif (Metadata)
                const exifBuffer = await writeExif(webpBuffer, "Created by", "Alfread")

                // Kirim Stiker
                await sock.sendMessage(m.key.remoteJid, { 
                    sticker: exifBuffer 
                }, { quoted: m })

                // Bersihkan file temp
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp)
                
                await sock.sendMessage(m.key.remoteJid, { react: { text: "✅", key: m.key } })
            })

        } catch (e) {
            console.error("QC Error:", e)
            await sock.sendMessage(m.key.remoteJid, { text: "❌ Error sistem." }, { quoted: m })
        }
    }
}

// --- FUNGSI TAMBAHAN UNTUK METADATA (EXIF) ---
async function writeExif(image, packname, author) {
    const json = {
        "sticker-pack-id": "com.alfread.bot",
        "sticker-pack-name": packname,
        "sticker-pack-publisher": author,
        "emojis": ["🤖"]
    }
    
    const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
    const jsonBuffer = Buffer.from(JSON.stringify(json), "utf-8")
    const exif = Buffer.concat([exifAttr, jsonBuffer])
    
    exif.writeUIntLE(jsonBuffer.length, 14, 4)

    // Load image dan cari posisi untuk menyisipkan Exif
    // Karena ini raw buffer manipulation, kita pakai cara simpel:
    // Kita butuh library 'webpmux' atau sejenisnya untuk cara 'bersih',
    // Tapi karena user kesulitan install lib, kita pakai library 'webpmux' bawaan Node (jika ada) atau
    // Cara paling aman di Termux tanpa install 'wa-sticker-formatter' adalah membiarkan FFmpeg handle gambar,
    // lalu kita pakai trik di bawah untuk metadata.
    
    // *CATATAN*: Manipulasi Buffer WebP manual sangat rumit tanpa library.
    // Jika kode di bawah error, hapus bagian writeExif dan kirim 'webpBuffer' saja.
    // Namun, kode di bawah adalah implementasi minimal untuk menyisipkan chunk EXIF.
    
    const RIFF = Buffer.from("RIFF")
    const WEBP = Buffer.from("WEBP")
    const VP8X = Buffer.from("VP8X")
    
    if (!image.slice(0, 4).equals(RIFF) || !image.slice(8, 12).equals(WEBP)) return image

    // Cek Chunk VP8X
    // (Implementasi full exif writer terlalu panjang untuk satu file tanpa library 'libwebp')
    // Jadi untuk solusi stabil TANPA npm install tambahan yang error kemarin:
    // Saya kembalikan image asli dulu agar bot jalan.
    // Metadata WA biasanya butuh library 'node-webpmux'.
    
    // SAYA AKAN MENGGUNAKAN LIBRARY BAWAAN 'node-webpmux' JIKA TERINSTALL.
    // TAPI KARENA KAMU MINTA FULL CODE DAN TIDAK MAU RIBET INSTALL:
    try {
        const webpmux = require("node-webpmux")
        const img = new webpmux.Image()
        await img.load(image)
        img.exif = exif
        return await img.save(null)
    } catch (e) {
        // Jika user belum install node-webpmux, kembalikan gambar polos (daripada error)
        // Saran: npm install node-webpmux
        return image
    }
}
