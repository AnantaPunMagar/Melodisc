// bot.js — fully fixed: auto-join on /playlist, lazy-load, one-by-one playback
import dotenv from "dotenv";
dotenv.config();

import fs, { createReadStream, unlinkSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import https from "https";
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  demuxProbe,
  StreamType,
} from "@discordjs/voice";
import SpotifyWebApi from "spotify-web-api-node";

// === ESM path setup ===
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ytdlpPath = path.join(__dirname, "yt-dlp");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

const queues = new Map();
const cookiesFile = "/home/container/cookies.txt";

// === Resolve Spotify short links ===
function resolveSpotifyLink(url) {
  return new Promise((resolve) => {
    if (!/^(https?:\/\/)?(spotify\.(link|app\.link))/.test(url)) {
      return resolve(url);
    }

    const req = https.get(url, (res) => {
      if (res.headers.location) {
        console.log(`Resolved short link: ${url} → ${res.headers.location}`);
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    });

    req.on("error", () => resolve(url));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(url);
    });
  });
}

// === Build yt-dlp args ===
const buildArgs = (baseArgs) => {
  const args = [...baseArgs];
  if (fs.existsSync(cookiesFile)) {
    args.splice(-1, 0, "--cookies", cookiesFile);
  }
  return args;
};

// === Extract metadata (for direct URLs) ===
const extractMetadata = async (url) => {
  console.log(`Extracting metadata for: ${url}`);
  return new Promise((resolve, reject) => {
    const baseArgs = [
      "--no-check-certificates",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "--print",
      "%(title)s|%(webpage_url)s",
      url,
    ];
    const args = buildArgs(baseArgs);
    const process = spawn(ytdlpPath, args);
    let output = "";
    let stderr = "";
    process.stdout.on("data", (data) => (output += data.toString()));
    process.stderr.on("data", (data) => (stderr += data.toString()));
    process.on("close", (code) => {
      if (code === 0 && output.trim()) {
        const [title, webpageUrl] = output.trim().split("|");
        resolve({ title: title.trim(), url: webpageUrl.trim() || url });
      } else {
        console.error(`Metadata extraction failed: code ${code}, stderr: ${stderr}`);
        reject(new Error(`Metadata extraction failed: code ${code}`));
      }
    });
  });
};

// === YouTube search fallback ===
const fallbackSearch = async (searchQuery) => {
  console.log(`Searching YouTube via yt-dlp for: ${searchQuery}`);
  return new Promise((resolve, reject) => {
    const ytSearch = `ytsearch1:${searchQuery}`;
    const baseArgs = [
      "--flat-playlist",
      "--no-check-certificates",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "--print",
      "%(title)s|%(id)s",
      "--playlist-end",
      "1",
      ytSearch,
    ];
    const args = buildArgs(baseArgs);
    const process = spawn(ytdlpPath, args);
    let output = "";
    let stderr = "";
    process.stdout.on("data", (data) => (output += data.toString()));
    process.stderr.on("data", (data) => (stderr += data.toString()));
    process.on("close", (code) => {
      if (code === 0 && output.trim()) {
        const [title, videoId] = output.trim().split("|");
        if (title && /^[a-zA-Z0-9_-]{11}$/.test(videoId?.trim())) {
          resolve({
            title: title.trim(),
            url: `https://www.youtube.com/watch?v=${videoId.trim()}`,
          });
        } else {
          reject(new Error("No valid video results"));
        }
      } else {
        console.error(`Search failed: code ${code}, stderr: ${stderr}`);
        reject(new Error("Search failed"));
      }
    });
  });
};

// === Spotify playlist fetch ===
async function getSpotifyPlaylistTracks(playlistId) {
  let tracks = [];
  let offset = 0;
  const limit = 100;
  try {
    while (true) {
      const response = await spotifyApi.getPlaylistTracks(playlistId, { limit, offset });
      if (!response.body?.items) throw new Error("Invalid Spotify response");
      tracks = tracks.concat(response.body.items.map((item) => item.track));
      if (response.body.items.length < limit) break;
      offset += limit;
    }
    return tracks;
  } catch (error) {
    console.error(`Error fetching playlist tracks: ${error.message}`);
    throw error;
  }
}

// === Utilities ===
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) unlinkSync(p);
  } catch (e) {
    console.warn("Failed to unlink:", p, e.message);
  }
}

// === Discord Events ===
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Music!", { type: 2 });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guild.id;
  let serverQueue = queues.get(guildId);
  if (!serverQueue) {
    serverQueue = {
      queue: [],
      nowPlaying: null,
      loop: "off",
      connection: null,
      player: null,
      currentTempFile: null,
    };
    queues.set(guildId, serverQueue);
  }

  const commandName = interaction.commandName;

  if (commandName === "join") {
    if (!interaction.member.voice.channel)
      return interaction.reply("You are not in a voice channel!");
    const connection = joinVoiceChannel({
      channelId: interaction.member.voice.channel.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
    });
    serverQueue.connection = connection;
    if (!serverQueue.player) {
      const player = createAudioPlayer();
      connection.subscribe(player);
      serverQueue.player = player;
      player.on("error", (err) => console.error("Audio player error:", err));
    }
    await interaction.reply(`Joined ${interaction.member.voice.channel.name}`);
  } else if (commandName === "leave") {
    if (serverQueue.connection) {
      try { serverQueue.connection.destroy(); } catch (e) {}
      queues.delete(guildId);
      await interaction.reply("Left the voice channel");
    } else {
      await interaction.reply("I'm not in a voice channel!");
    }
  } else if (commandName === "play") {
    if (!interaction.member.voice.channel)
      return interaction.reply("You are not in a voice channel!");
    if (!serverQueue.connection) {
      const connection = joinVoiceChannel({
        channelId: interaction.member.voice.channel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });
      serverQueue.connection = connection;
      const player = createAudioPlayer();
      connection.subscribe(player);
      serverQueue.player = player;
      player.on("error", (err) => console.error("Player error:", err));
    }

    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferReply().catch(() => {});
    }

    let query = interaction.options.getString("query");
    console.log(`Processing /play: ${query}`);

    let actualQuery = query.toLowerCase().startsWith("url:") ? query.substring(4).trim() : query.trim();

    if (/^(https?:\/\/)?(spotify\.(link|app\.link))/.test(actualQuery)) {
      actualQuery = await resolveSpotifyLink(actualQuery);
    }

    // Handle Spotify playlist in /play
    const playlistMatch = actualQuery.match(/^https?:\/\/(?:open\.)?spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
    if (playlistMatch) {
      const playlistId = playlistMatch[1];
      try {
        await spotifyApi.clientCredentialsGrant().then((data) =>
          spotifyApi.setAccessToken(data.body["access_token"])
        );
        const tracks = await getSpotifyPlaylistTracks(playlistId);

        let addedCount = 0;
        for (const track of tracks) {
          if (track && track.name && track.artists?.[0]?.name) {
            serverQueue.queue.push({
              type: 'spotify',
              artist: track.artists[0].name,
              title: track.name
            });
            addedCount++;
          }
        }

        const replyText = `✅ Added ${addedCount} tracks from playlist to queue.`;
        interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);

        if (serverQueue.player?.state.status === AudioPlayerStatus.Idle) {
          playSong(guildId, interaction.channel);
        }
        return;
      } catch (error) {
        console.error(`Playlist error: ${error.message}`);
        const replyText = `Error: ${error.message}`;
        interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);
        return;
      }
    }

    // Handle single Spotify track
    const trackMatch = actualQuery.match(/^https?:\/\/(?:open\.)?spotify\.com\/track\/([a-zA-Z0-9]+)/);
    if (trackMatch) {
      try {
        await spotifyApi.clientCredentialsGrant().then((data) =>
          spotifyApi.setAccessToken(data.body["access_token"])
        );
        const trackId = trackMatch[1];
        const { body: track } = await spotifyApi.getTrack(trackId);
        serverQueue.queue.push({
          type: 'spotify',
          artist: track.artists[0].name,
          title: track.name
        });
      } catch (err) {
        console.error("Spotify track error:", err);
        const replyText = `Error fetching Spotify track: ${err.message}`;
        interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);
        return;
      }
    } else if (/^https?:\/\//.test(actualQuery)) {
      try {
        const song = await extractMetadata(actualQuery);
        serverQueue.queue.push(song);
      } catch (err) {
        console.error("Direct URL error:", err);
        const replyText = `Error: ${err.message}`;
        interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);
        return;
      }
    } else {
      try {
        const song = await fallbackSearch(actualQuery);
        serverQueue.queue.push(song);
      } catch (err) {
        console.error("Search error:", err);
        const replyText = `No results found for: ${actualQuery}`;
        interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);
        return;
      }
    }

    const replyText = `Added to queue: ${serverQueue.queue[serverQueue.queue.length - 1]?.title || 'song'}`;
    interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);

    if (serverQueue.player?.state.status === AudioPlayerStatus.Idle) {
      playSong(guildId, interaction.channel);
    }
  } else if (commandName === "playlist") {
    // ✅ Ensure user is in a voice channel
    if (!interaction.member.voice.channel) {
      return interaction.reply("You must be in a voice channel to use /playlist!");
    }

    let url = interaction.options.getString("url").trim();
    console.log(`Raw playlist URL: "${url}"`);

    if (/^(https?:\/\/)?(spotify\.(link|app\.link))/.test(url)) {
      url = await resolveSpotifyLink(url);
      console.log(`Resolved to: "${url}"`);
    }

    const playlistMatch = url.match(/^https?:\/\/(?:open\.)?spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
    if (!playlistMatch) {
      return interaction.reply("Provide a valid Spotify playlist URL.");
    }

    const playlistId = playlistMatch[1];

    // ✅ Auto-join voice channel if needed
    if (!serverQueue.connection) {
      const connection = joinVoiceChannel({
        channelId: interaction.member.voice.channel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });
      serverQueue.connection = connection;

      if (!serverQueue.player) {
        const player = createAudioPlayer();
        connection.subscribe(player);
        serverQueue.player = player;
        player.on("error", (err) => console.error("Audio player error:", err));
      }
    }

    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferReply().catch(() => {});
    }

    try {
      await spotifyApi.clientCredentialsGrant().then((data) =>
        spotifyApi.setAccessToken(data.body["access_token"])
      );
      const tracks = await getSpotifyPlaylistTracks(playlistId);

      let addedCount = 0;
      for (const track of tracks) {
        if (track && track.name && track.artists?.[0]?.name) {
          serverQueue.queue.push({
            type: 'spotify',
            artist: track.artists[0].name,
            title: track.name
          });
          addedCount++;
        }
      }

      const replyText = `✅ Added ${addedCount} tracks from playlist to queue.`;
      interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);

      // ✅ Start playback if idle
      if (serverQueue.player?.state.status === AudioPlayerStatus.Idle) {
        playSong(guildId, interaction.channel);
      }
    } catch (error) {
      console.error(`Playlist error: ${error.message}`);
      const replyText = `Error: ${error.message}`;
      interaction.deferred ? await interaction.followUp(replyText) : await interaction.reply(replyText);
    }
  } else if (commandName === "loop") {
    const mode = interaction.options.getString("mode");
    if (!["off", "single", "queue"].includes(mode))
      return interaction.reply("Invalid mode: off, single, or queue.");
    serverQueue.loop = mode;
    await interaction.reply(`Loop mode set to: ${mode}`);
  } else if (commandName === "stop") {
    if (serverQueue.player) {
      serverQueue.player.stop();
      serverQueue.queue = [];
      serverQueue.nowPlaying = null;
      await interaction.reply("Stopped playing and cleared the queue.");
    } else {
      await interaction.reply("Nothing is playing!");
    }
  } else if (commandName === "pause") {
    if (serverQueue.player?.state.status === AudioPlayerStatus.Playing) {
      serverQueue.player.pause();
      await interaction.reply("Paused");
    } else {
      await interaction.reply("Nothing is playing!");
    }
  } else if (commandName === "resume") {
    if (serverQueue.player?.state.status === AudioPlayerStatus.Paused) {
      serverQueue.player.unpause();
      await interaction.reply("Resumed");
    } else {
      await interaction.reply("Not paused!");
    }
  } else if (commandName === "skip") {
    if (serverQueue.player) {
      serverQueue.player.stop();
      await interaction.reply("Skipped to next song");
    } else {
      await interaction.reply("Nothing is playing!");
    }
  } else if (commandName === "queue") {
    if (serverQueue.queue.length === 0) {
      const msg = serverQueue.nowPlaying
        ? `Now Playing: ${serverQueue.nowPlaying.title}\nQueue is empty!`
        : "Queue is empty!";
      return interaction.reply(msg);
    }
    const now = serverQueue.nowPlaying ? `Now Playing: ${serverQueue.nowPlaying.title}\n\n` : "";
    const list = serverQueue.queue.map((s, i) => `${i + 1}. ${s.title || `${s.artist} - ${s.title}`}`).join("\n");
    await interaction.reply(`${now}Current queue:\n${list}`);
  }
});

// === Play Song — resolves Spotify tracks on-demand ===
async function playSong(guildId, channel) {
  console.log("▶️ playSong called for guild:", guildId); // debug log

  const serverQueue = queues.get(guildId);
  if (!serverQueue || serverQueue.queue.length === 0) {
    try { serverQueue?.player?.stop(); } catch (e) {}
    serverQueue.nowPlaying = null;
    return channel.send("Queue is empty! Stopping playback.");
  }

  if (!serverQueue.player) {
    console.error("No player for this server.");
    return channel.send("Playback error: audio player missing.");
  }

  let song = serverQueue.queue[0];

  if (song.type === 'spotify') {
    const searchQuery = `${song.artist} ${song.title}`;
    try {
      console.log(`🔍 Searching YouTube for: ${searchQuery}`);
      const ytSong = await fallbackSearch(searchQuery);
      serverQueue.queue[0] = ytSong;
      song = ytSong;
    } catch (err) {
      console.error(`❌ Failed to find on YouTube: ${searchQuery}`);
      await channel.send(`❌ Skipped: "${searchQuery}" (not found on YouTube)`);
      serverQueue.queue.shift();
      return playSong(guildId, channel);
    }
  }

  serverQueue.nowPlaying = song;

  const tempDir = path.resolve("./temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempFileBase = path.join(tempDir, `audio_${guildId}_${Date.now()}`);
  const maxRetries = 3;
  let retries = 0;
  let actualTempFile = null;

  console.log(`▶️ Attempting to download and play: ${song.title} (${song.url})`);
  const hasCookies = fs.existsSync(cookiesFile);
  console.log(`Using ${hasCookies ? "cookies" : "no cookies"}`);

  while (retries < maxRetries) {
    try {
      const baseArgs = [
        "-f", "bestaudio[ext=opus]/bestaudio",
        "--audio-quality", "0",
        "--no-playlist",
        "--no-check-certificates",
        "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "-o", `${tempFileBase}.%(ext)s`,
        song.url,
      ];
      const args = buildArgs(baseArgs);
      const process = spawn(ytdlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      process.stderr.on("data", (d) => {
        const msg = d.toString();
        stderr += msg;
        if (!(msg.includes("Signature extraction failed") || msg.includes("SABR"))) {
          console.error(`yt-dlp stderr: ${msg}`);
        }
      });

      await new Promise((resolve, reject) => {
        process.on("error", reject);
        process.on("close", (code) => {
          if (code !== 0) {
            console.error(`Download failed: code ${code}, stderr: ${stderr}`);
            if (stderr.includes("Sign in to confirm") || stderr.toLowerCase().includes("bot")) {
              reject(new Error("Anti-bot restriction detected"));
            } else {
              reject(new Error(`yt-dlp exited with code ${code}`));
            }
          } else resolve();
        });
      });

      const dir = path.dirname(tempFileBase);
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(tempFileBase)));
      if (files.length === 0) throw new Error("No file downloaded");
      actualTempFile = path.join(dir, files[0]);

      const stats = fs.statSync(actualTempFile);
      if (stats.size < 1024) throw new Error("Downloaded file too small");

      console.log(`📥 Downloaded to ${actualTempFile}, size: ${stats.size}`);
      serverQueue.currentTempFile = actualTempFile;
      break;
    } catch (err) {
      console.error(`Download attempt ${retries + 1} failed:`, err.message);
      if (err.message.includes("Anti-bot restriction")) {
        await channel.send(`🚫 Cannot play "${song.title}" due to YouTube restrictions. Skipping...`);
        serverQueue.queue.shift();
        serverQueue.nowPlaying = null;
        safeUnlink(actualTempFile);
        if (serverQueue.queue.length > 0) return playSong(guildId, channel);
        return serverQueue.player.stop();
      }
      retries++;
      if (retries >= maxRetries) {
        await channel.send(`⚠️ Failed to download "${song.title}" after ${maxRetries} attempts. Skipping...`);
        serverQueue.queue.shift();
        serverQueue.nowPlaying = null;
        safeUnlink(actualTempFile);
        if (serverQueue.queue.length > 0) return playSong(guildId, channel);
        return serverQueue.player.stop();
      }
      await wait(2000);
    }
  }

  // Play audio
  let resource;
  try {
    let input = createReadStream(actualTempFile);
    const { stream: probedStream, type } = await demuxProbe(input);
    resource = createAudioResource(probedStream, { inputType: type });
  } catch (probeErr) {
    console.warn(`demuxProbe failed, falling back to Arbitrary: ${probeErr.message}`);
    const input = createReadStream(actualTempFile);
    resource = createAudioResource(input, { inputType: StreamType.Arbitrary });
  }

  serverQueue.player.play(resource);

  // Event handlers
  const onIdle = async () => {
    const tempFile = serverQueue.currentTempFile;
    serverQueue.currentTempFile = null;
    safeUnlink(tempFile);

    if (serverQueue.loop === "single") {
      await channel.send(`🔂 Now playing: ${serverQueue.nowPlaying.title}`);
      return playSong(guildId, channel);
    } else if (serverQueue.loop === "queue") {
      const currentSong = serverQueue.queue.shift();
      serverQueue.nowPlaying = null;
      serverQueue.queue.push(currentSong);
      return playSong(guildId, channel);
    } else {
      serverQueue.queue.shift();
      serverQueue.nowPlaying = null;
      if (serverQueue.queue.length > 0) return playSong(guildId, channel);
      serverQueue.player.stop();
      return channel.send("Queue is empty! Stopping playback.");
    }
  };

  const onError = async (err) => {
    console.error("Player error:", err);
    const tempFile = serverQueue.currentTempFile;
    serverQueue.currentTempFile = null;
    safeUnlink(tempFile);
    await channel.send("An error occurred while playing the song. Skipping...");
    if (serverQueue.loop !== "single") {
      serverQueue.queue.shift();
      serverQueue.nowPlaying = null;
    }
    await wait(500);
    if (serverQueue.queue.length > 0) return playSong(guildId, channel);
    serverQueue.player.stop();
  };

  const stateChangeHandler = (oldState, newState) => {
    if (newState.status === AudioPlayerStatus.Idle) {
      serverQueue.player.removeListener("stateChange", stateChangeHandler);
      onIdle().catch(console.error);
    }
  };
  serverQueue.player.on("stateChange", stateChangeHandler);

  const errorHandler = (err) => {
    serverQueue.player.removeListener("error", errorHandler);
    onError(err).catch(console.error);
  };
  serverQueue.player.on("error", errorHandler);
}

// === Slash Commands ===
const commands = [
  new SlashCommandBuilder().setName("join").setDescription("Join the voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song (YouTube, Spotify track, or search)")
    .addStringOption((option) =>
      option.setName("query").setDescription("URL or search term").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Add a Spotify playlist")
    .addStringOption((option) =>
      option.setName("url").setDescription("Spotify playlist URL").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set loop mode")
    .addStringOption((option) =>
      option.setName("mode").setDescription("Loop mode").setRequired(true)
      .addChoices(
        { name: "off", value: "off" },
        { name: "single", value: "single" },
        { name: "queue", value: "queue" }
      )
    ),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playing"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip to next song"),
  new SlashCommandBuilder().setName("queue").setDescription("Show current queue"),
].map((cmd) => cmd.toJSON());

// === Deploy Commands ===
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
(async () => {
  try {
    console.log("Started refreshing application (/) commands.");
    const route = process.env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(`Command deployment error: ${error.message}`);
  }
})();

client.login(process.env.DISCORD_BOT_TOKEN);
