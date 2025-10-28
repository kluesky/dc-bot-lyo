import 'dotenv/config';
import axios from 'axios';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } from 'discord.js';

// --- Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
});

const PREFIX = '!';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const PASTEFY_API_KEY = process.env.PASTEFY_API_KEY;
const PASTEFY_PASTE_ID = process.env.PASTEFY_PASTE_ID;

// --- Colors untuk embed
const COLORS = {
  SUCCESS: 0x00FF7F,
  ERROR: 0xFF4444,
  INFO: 0x0099FF,
  WARNING: 0xFFAA00,
  PRIMARY: 0x5865F2,
  DARK: 0x2C2F33
};

// --- Axios instance untuk Pastefy
const pf = axios.create({
  baseURL: 'https://pastefy.app/api/v2',
  headers: {
    Authorization: `Bearer ${PASTEFY_API_KEY}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

// ---- Simple lock supaya edit tidak tabrakan
let lock = Promise.resolve();
const withLock = (fn) => {
  const run = async () => fn().catch((e) => { throw e; });
  const next = lock.then(run, run);
  lock = next.catch(() => {});
  return next;
};

// ---- Helpers
const normalize = (s) => s.trim().replace(/\r/g, '');
const toUniqueList = (text) => {
  const lines = normalize(text).split('\n').filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const k = line.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(line); }
  }
  return out;
};

// Format timestamp
const formatTime = () => {
  return `<t:${Math.floor(Date.now() / 1000)}:R>`;
};

// Create progress bar
const createProgressBar = (current, max, length = 10) => {
  const percentage = current / max;
  const filled = Math.round(length * percentage);
  const empty = length - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${Math.round(percentage * 100)}%`;
};

// ========== ROBLOX API VERIFICATION (FIXED) ==========
async function verifyRobloxUser(username) {
  try {
    console.log(`🔍 Verifying Roblox user: ${username}`);
    
    // Validasi format username dulu
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      throw new Error('Format username tidak valid! Harus 3-20 karakter, hanya huruf, angka, dan underscore');
    }

    // Gunakan API yang sama seperti kode Python yang berfungsi
    const url = "https://users.roblox.com/v1/usernames/users";
    const payload = { usernames: [username] };
    const headers = { "Content-Type": "application/json" };
    
    const response = await axios.post(url, payload, { 
      headers, 
      timeout: 10000 
    });

    if (response.status === 200) {
      const data = response.data;
      
      if (data.data && data.data.length > 0) {
        const userData = data.data[0];
        
        // Pastikan exact match (case insensitive)
        if (userData.name.toLowerCase() === username.toLowerCase()) {
          console.log(`✅ Roblox user found: ${userData.name} (ID: ${userData.id})`);
          
          return {
            success: true,
            user: {
              id: userData.id,
              name: userData.name, // Gunakan nama exact dari Roblox
              displayName: userData.displayName || userData.name
            }
          };
        } else {
          throw new Error('Username tidak tepat. Pastikan ejaan sama persis!');
        }
      } else {
        throw new Error('Username tidak ditemukan di Roblox!');
      }
    } else {
      throw new Error(`Roblox API error: ${response.status}`);
    }
    
  } catch (error) {
    console.error('❌ Roblox verification error:', error.message);
    
    if (error.code === 'ECONNABORTED') {
      throw new Error('Timeout: Roblox server lambat. Silakan coba lagi.');
    }
    
    if (error.response) {
      if (error.response.status === 429) {
        throw new Error('Terlalu banyak request. Tunggu beberapa saat lalu coba lagi.');
      } else if (error.response.status >= 500) {
        throw new Error('Server Roblox sedang gangguan. Coba lagi nanti.');
      }
    }
    
    // Pass through error message dari validation
    if (error.message.includes('Format username') || error.message.includes('tidak ditemukan')) {
      throw error;
    }
    
    throw new Error(`Gagal memverifikasi user: ${error.message}`);
  }
}

// ========== WHITELIST FUNCTIONS ==========
async function getWhitelistContent() {
  const res = await pf.get(`/paste/${PASTEFY_PASTE_ID}`);
  return typeof res.data?.content === 'string' ? res.data.content : '';
}

async function putWhitelistContent({ title, content, visibility = 'UNLISTED' }) {
  await pf.put(`/paste/${PASTEFY_PASTE_ID}`, {
    title,
    content,
    encrypted: false,
    visibility,
    tags: []
  });
}

// MODIFIED: Tambahkan Roblox verification sebelum register
async function registerWhitelist(usernameRaw) {
  const username = usernameRaw.trim();
  if (!username) throw new Error('Username kosong');

  return withLock(async () => {
    // 1. Verifikasi username di Roblox
    const verification = await verifyRobloxUser(username);
    if (!verification.success) {
      throw new Error('Gagal memverifikasi user Roblox');
    }

    const verifiedUsername = verification.user.name; // Gunakan nama exact dari Roblox

    // 2. Cek di whitelist
    const current = await getWhitelistContent();
    const list = toUniqueList(current);
    const isNew = !list.map(x => x.toLowerCase()).includes(verifiedUsername.toLowerCase());
    
    if (isNew) {
      list.push(verifiedUsername);
    }
    
    // 3. Update whitelist
    const newContent = list.join('\n');
    await putWhitelistContent({ 
      title: 'whitelist', 
      content: newContent, 
      visibility: 'UNLISTED' 
    });
    
    return {
      isNew,
      totalCount: list.length,
      username: verifiedUsername,
      robloxData: verification.user
    };
  });
}

async function getWhitelistStats() {
  const content = await getWhitelistContent();
  const list = toUniqueList(content);
  return {
    count: list.length,
    usernames: list
  };
}

// Check single user in whitelist
async function checkUserInWhitelist(username) {
  const stats = await getWhitelistStats();
  return stats.usernames.map(u => u.toLowerCase()).includes(username.toLowerCase());
}

// ========== EMBEDS ==========
function createSuccessEmbed(title, description, fields = []) {
  return new EmbedBuilder()
    .setColor(COLORS.SUCCESS)
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .addFields(fields)
    .setTimestamp()
    .setFooter({ 
      text: 'Lyora Management - Roblox Verified', 
      iconURL: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR8J5r189q9gTV0e13DktVjs6-IYI0izrw35CvXJf3yqw&s=10' 
    });
}

function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(COLORS.ERROR)
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setTimestamp()
    .setFooter({ 
      text: 'Lyora Management - Verification Failed', 
      iconURL: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR8J5r189q9gTV0e13DktVjs6-IYI0izrw35CvXJf3yqw&s=10' 
    });
}

function createInfoEmbed(title, description, fields = []) {
  return new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(`📊 ${title}`)
    .setDescription(description)
    .addFields(fields)
    .setTimestamp()
    .setFooter({ 
      text: 'Lyora Management - Whitelist System', 
      iconURL: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR8J5r189q9gTV0e13DktVjs6-IYI0izrw35CvXJf3yqw&s=10' 
    });
}

function createVerificationEmbed(username) {
  return new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle(`🔍 Verifying Roblox User`)
    .setDescription(`Memverifikasi **${username}** di Roblox...`)
    .setTimestamp()
    .setFooter({ 
      text: 'Lyora Management - Verification in Progress', 
      iconURL: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR8J5r189q9gTV0e13DktVjs6-IYI0izrw35CvXJf3yqw&s=10' 
    });
}

// --- Action Buttons
function createWhitelistButtons() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('refresh_whitelist')
        .setLabel('🔄 Refresh')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('view_stats')
        .setLabel('📊 Stats')
        .setStyle(ButtonStyle.Primary)
    );
}

// --- Bot events
client.once('ready', () => {
  console.log(`🎯 ${client.user.tag} ready!`);
  console.log(`📝 Connected to Pastefy: ${PASTEFY_PASTE_ID}`);
  console.log(`🔗 Roblox API: Enabled (Fixed Version)`);
  
  // Set bot activity
  client.user.setActivity('Whitelist User', { type: 'WATCHING' });
});

// Button interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    await interaction.deferUpdate();
    
    if (interaction.customId === 'refresh_whitelist') {
      const stats = await getWhitelistStats();
      const embed = createInfoEmbed(
        'Whitelist Updated',
        `Daftar whitelist telah diperbarui ${formatTime()}`,
        [
          { name: 'Total Users', value: `**${stats.count}** terdaftar`, inline: true },
          { name: 'Progress', value: createProgressBar(stats.count, 100), inline: true },
          { name: 'System', value: '✅ Roblox Verified', inline: true }
        ]
      );
      
      await interaction.editReply({ embeds: [embed], components: [createWhitelistButtons()] });
    }
    
    if (interaction.customId === 'view_stats') {
      const stats = await getWhitelistStats();
      const recentUsers = stats.usernames.slice(-5).join('\n') || 'Tidak ada data';
      
      const embed = createInfoEmbed(
        '📊 Whitelist Statistics',
        `Statistik lengkap sistem whitelist dengan verifikasi Roblox`,
        [
          { name: 'Total Registered', value: `**${stats.count}** verified users`, inline: true },
          { name: 'Last Updated', value: formatTime(), inline: true },
          { name: 'Verification', value: '✅ Roblox API', inline: true },
          { name: 'Recent Additions', value: `\`\`\`${recentUsers}\`\`\``, inline: false }
        ]
      );
      
      await interaction.editReply({ embeds: [embed], components: [createWhitelistButtons()] });
    }
  } catch (error) {
    console.error('Button error:', error);
  }
});

// ========== MESSAGE COMMANDS ==========
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || '').toLowerCase();

  // Command: whitelist
  if (command === 'whitelist') {
    if (!args[0]) {
      const helpEmbed = createInfoEmbed(
        'Whitelist Command Help',
        'Gunakan command berikut untuk mengelola whitelist dengan verifikasi Roblox:',
        [
          { name: 'Register', value: '`!whitelist <username>`', inline: true },
          { name: 'Check List', value: '`!cekwl`', inline: true },
          { name: 'Check User', value: '`!cekwl <username>`', inline: true },
          { name: 'Statistics', value: '`!wlstats`', inline: true },
          { name: 'Help', value: '`!wlhelp`', inline: true }
        ]
      );
      return message.reply({ embeds: [helpEmbed] });
    }

    const robloxUsername = args[0];

    try {
      // Kirim embed verifikasi dulu
      const verificationMsg = await message.reply({ 
        embeds: [createVerificationEmbed(robloxUsername)] 
      });

      // Process whitelist dengan verifikasi Roblox
      const result = await registerWhitelist(robloxUsername);
      
      // Hapus pesan verifikasi
      await verificationMsg.delete().catch(() => {});
      
      if (result.isNew) {
        const robloxProfileUrl = `https://www.roblox.com/users/${result.robloxData.id}/profile`;
        
        const successEmbed = createSuccessEmbed(
          'Registration Successful!',
          `**${result.username}** telah berhasil diverifikasi dan didaftarkan ke whitelist`,
          [
            { name: 'Roblox ID', value: `[${result.robloxData.id}](${robloxProfileUrl})`, inline: true },
            { name: 'Display Name', value: result.robloxData.displayName || result.username, inline: true },
            { name: 'Verification', value: '✅ Valid', inline: true },
            { name: 'Total Whitelisted', value: `**${result.totalCount}** users`, inline: true },
            { name: 'Status', value: '✅ **VERIFIED & REGISTERED**', inline: true },
            { name: 'Timestamp', value: formatTime(), inline: true }
          ]
        );
        
        await message.reply({ 
          embeds: [successEmbed],
          components: [createWhitelistButtons()]
        });
      } else {
        const infoEmbed = createInfoEmbed(
          'Already Registered',
          `**${result.username}** sudah terdaftar sebelumnya di whitelist`,
          [
            { name: 'Total Whitelisted', value: `**${result.totalCount}** users`, inline: true },
            { name: 'Status', value: '🔄 **DUPLICATE**', inline: true },
            { name: 'Verification', value: '✅ Roblox Verified', inline: true }
          ]
        );
        
        await message.reply({ embeds: [infoEmbed] });
      }
    } catch (err) {
      console.error('registerWhitelist error:', err.message);
      const errorEmbed = createErrorEmbed(
        'Registration Failed',
        `**Error:** ${err.message}\n\nPastikan:\n• Username tepat dan ada di Roblox\n• Format: 3-20 karakter, huruf/angka/underscore saja\n• Tidak ada spasi atau karakter khusus`
      );
      await message.reply({ embeds: [errorEmbed] });
    }
  }

  // Command: cekwl (check all or specific user)
  if (command === 'cekwl') {
    try {
      // Jika ada username spesifik
      if (args[0]) {
        const username = args[0];
        const isRegistered = await checkUserInWhitelist(username);
        const stats = await getWhitelistStats();
        
        if (isRegistered) {
          const embed = createSuccessEmbed(
            '✅ Terdaftar di Whitelist',
            `Username **${username}** terdaftar di whitelist!`,
            [
              { name: 'Total Whitelisted', value: `**${stats.count}** users`, inline: true },
              { name: 'Status', value: '✅ VERIFIED', inline: true },
              { name: 'Last Check', value: formatTime(), inline: true }
            ]
          );
          await message.reply({ embeds: [embed] });
        } else {
          const embed = createErrorEmbed(
            '❌ Tidak Terdaftar',
            `Username **${username}** tidak terdaftar di whitelist.`,
            [
              { name: '💡 Tips', value: 'Gunakan `!whitelist <username>` untuk mendaftar', inline: false }
            ]
          );
          await message.reply({ embeds: [embed] });
        }
        return;
      }
      
      // Jika tidak ada args, show all whitelist
      const stats = await getWhitelistStats();
      
      if (stats.count === 0) {
        const emptyEmbed = createInfoEmbed(
          'Whitelist Empty',
          'Belum ada user yang terdaftar di whitelist.'
        );
        return message.reply({ embeds: [emptyEmbed] });
      }

      const chunkSize = 20;
      const chunks = [];
      for (let i = 0; i < stats.usernames.length; i += chunkSize) {
        chunks.push(stats.usernames.slice(i, i + chunkSize));
      }

      for (let i = 0; i < chunks.length; i++) {
        const embed = createInfoEmbed(
          `📋 Whitelist Users (Page ${i + 1}/${chunks.length})`,
          `Total: **${stats.count}** verified users`,
          [
            { 
              name: `Users ${i * chunkSize + 1}-${Math.min((i + 1) * chunkSize, stats.count)}`, 
              value: `\`\`\`${chunks[i].join('\n')}\`\`\`` 
            }
          ]
        );
        
        if (i === 0) {
          await message.reply({ embeds: [embed], components: chunks.length > 1 ? [createWhitelistButtons()] : [] });
        } else {
          await message.channel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.error('getWhitelist error:', err.response?.data || err.message);
      const errorEmbed = createErrorEmbed(
        'Fetch Failed',
        'Gagal mengambil data whitelist.'
      );
      await message.reply({ embeds: [errorEmbed] });
    }
  }

  // Command: wlstats
  if (command === 'wlstats') {
    try {
      const stats = await getWhitelistStats();
      const recentUsers = stats.usernames.slice(-5).join('\n') || 'Tidak ada data';
      
      const statsEmbed = createInfoEmbed(
        '📊 Whitelist Statistics',
        `Statistik lengkap sistem whitelist dengan verifikasi Roblox`,
        [
          { name: 'Total Users', value: `**${stats.count}** verified`, inline: true },
          { name: 'Storage', value: createProgressBar(stats.count, 200), inline: true },
          { name: 'Verification', value: '✅ Roblox API', inline: true },
          { name: 'Last Updated', value: formatTime(), inline: true },
          { name: 'Recent 5 Users', value: `\`\`\`${recentUsers}\`\`\``, inline: false }
        ]
      );
      
      await message.reply({ 
        embeds: [statsEmbed],
        components: [createWhitelistButtons()]
      });
    } catch (error) {
      const errorEmbed = createErrorEmbed('Statistics Error', 'Gagal mengambil statistik.');
      await message.reply({ embeds: [errorEmbed] });
    }
  }

  // Command: wlhelp
  if (command === 'wlhelp') {
    const helpEmbed = createInfoEmbed(
      'Lyora Management',
      'Register Whitelist CMD',
      [
        { 
          name: '📝 Available Commands', 
          value: [
            '`!whitelist <username>` - Daftarkan username (diverifikasi di Roblox)',
            '`!cekwl` - Lihat semua daftar whitelist',
            '`!cekwl <username>` - Cek status user tertentu',
            '`!wlstats` - Statistik lengkap',
            '`!wlhelp` - Bantuan ini'
          ].join('\n') 
        },
        {
          name: '🔒 Security Features',
          value: [
            '✅ Roblox username verification',
            '✅ Auto-format correction', 
            '✅ Duplicate prevention',
            '✅ Real-time validation'
          ].join('\n')
        },
        {
          name: '📋 Requirements',
          value: [
            '• Username harus ada di Roblox',
            '• 3-20 karakter panjangnya',
            '• Hanya huruf, angka, underscore',
            '• Tidak mengandung karakter khusus'
          ].join('\n')
        }
      ]
    );
    
    await message.reply({ embeds: [helpEmbed] });
  }
});

// --- Start bot
if (!BOT_TOKEN || !PASTEFY_API_KEY || !PASTEFY_PASTE_ID) {
  console.error('❌ Missing environment variables!');
  process.exit(1);
}

client.login(BOT_TOKEN);