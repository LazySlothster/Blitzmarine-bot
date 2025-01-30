const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType
} = require('discord.js');
const fs = require('fs/promises');

// Global state with efficient data structures
const state = {
  config: {},
  valorData: {},
  lastUpdate: null,
  userStats: {},
  lastEvent: { id: null, timestamp: null, host: null }
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Core functions with optimized error handling
async function loadConfigAndData() {
  try {
    const [configData, valorData] = await Promise.all([
      fs.readFile('./config.json', 'utf-8'),
      fs.readFile('./valorData.json', 'utf-8').catch(() => '{}')
    ]);
    
    state.config = JSON.parse(configData);
    Object.assign(state, JSON.parse(valorData));
    return true;
  } catch (error) {
    console.error('Error loading config or valor data:', error);
    return false;
  }
}

async function saveValorData() {
  try {
    const { valorData, lastUpdate, userStats } = state;
    await fs.writeFile(
      './valorData.json',
      JSON.stringify({ valorData, lastUpdate, userStats }, null, 2)
    );
    return true;
  } catch (error) {
    console.error('Error saving valor data:', error);
    return false;
  }
}

// Modified commands setup
async function setupCommands(client) {
  const rest = new REST({ version: '10' }).setToken(state.config.token);
  
  try {
    const existingCommands = await rest.get(
      Routes.applicationCommands(client.user.id)
    );

    const entryPointCommand = existingCommands.find(cmd => cmd.name === 'entry');

    if (!entryPointCommand) {
      console.error('Entry Point command not found!');
      return;
    }

    const commands = [
      {
        name: entryPointCommand.name,
        description: entryPointCommand.description,
        type: entryPointCommand.type,
        options: entryPointCommand.options || []
      },
      {
        name: 'valor',
        description: 'View valor points for a user',
        type: 1,
        options: [{
          name: 'user',
          description: 'The user to check valor for',
          type: 6,
          required: false
        }]
      },
      {
        name: 'leaderboard',
        description: 'View the valor leaderboard',
        type: 1
      },
      {
        name: 'update',
        description: 'Update valor points from channel messages',
        type: 1
      },
      {
        name: 'profile',
        description: 'View detailed profile statistics',
        type: 1,
        options: [{
          name: 'user',
          description: 'The user to check profile for',
          type: 6,
          required: false
        }]
      },
      {
        name: 'add',
        description: 'Add valor points to a user',
        type: 1,
        options: [
          {
            name: 'user',
            description: 'The user to add valor points to',
            type: 6,
            required: true
          },
          {
            name: 'amount',
            description: 'Amount of valor points to add',
            type: 4,
            required: true
          }
        ]
      },
      {
        name: 'remove',
        description: 'Remove valor points from a user',
        type: 1,
        options: [
          {
            name: 'user',
            description: 'The user to remove valor points from',
            type: 6,
            required: true
          },
          {
            name: 'amount',
            description: 'Amount of valor points to remove',
            type: 4,
            required: true
          }
        ]
      }
    ];

    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    
    console.log('✅ Commands registered successfully');
  } catch (error) {
    console.error('Error setting up commands:', error);
    throw error;
  }
}

// Updated parseEventMessage function to handle valor points correctly
function parseEventMessage(content) {
  const lines = content.split('\n').filter(Boolean);
  const valorChanges = new Map();
  const statChanges = new Map();

  const eventIdMatch = lines[0]?.match(/Event ID:\s*((?:P|GT|DT|R)\d{4})/);
  if (!eventIdMatch) return { valorChanges, statChanges };

  const eventId = eventIdMatch[1];
  const hostLine = lines.find(line => line.toLowerCase().startsWith('host:'));
  const hostMatch = hostLine?.match(/Host:\s*<@!?(\d+)>/);
  const eventHost = hostMatch?.[1];

  const attendeesIndex = lines.findIndex(line => line.toLowerCase().includes('attendees:'));
  if (attendeesIndex === -1) return { valorChanges, statChanges };

  // Process attendees with improved valor calculation
  const attendeePattern = /^-\s*<@!?(\d+)>.*\|\s*(\d*V|V|INA|DO|AFK)\b/i;
  lines.slice(attendeesIndex + 1).forEach(line => {
    const match = line.match(attendeePattern);
    if (!match) return;

    const [, userId, status] = match;
    const upperStatus = status.toUpperCase();
    
    const stats = {
      eventsAttended: 1,
      inaCount: upperStatus === 'INA' ? 1 : 0,
      doCount: upperStatus === 'DO' ? 1 : 0,
      valorChange: 0,
      eventsHosted: 0
    };

    if (upperStatus === 'DO') {
      stats.valorChange = -1;
    } else if (upperStatus === 'V') {
      stats.valorChange = 1;
    } else if (!['INA', 'AFK'].includes(upperStatus)) {
      const multiplier = parseInt(upperStatus);
      if (!isNaN(multiplier)) {
        stats.valorChange = multiplier;
      }
    }

    valorChanges.set(userId, stats.valorChange);
    statChanges.set(userId, stats);
  });

  // Add host stats and valor
  if (eventHost) {
    const hostStats = statChanges.get(eventHost) || {
      eventsAttended: 0,
      inaCount: 0,
      doCount: 0,
      valorChange: 1, // Host gets 1 valor point
      eventsHosted: 0
    };
    hostStats.eventsHosted = 1;
    valorChanges.set(eventHost, (valorChanges.get(eventHost) || 0) + 1); // Add 1 valor for hosting
    statChanges.set(eventHost, hostStats);
  }

  return { valorChanges, statChanges, eventId, eventHost, timestamp: new Date().toISOString() };
}

async function loadHistoricalValorPoints() {
  try {
    const channel = await client.channels.fetch(state.config.eventChannelId);
    if (!channel) throw new Error('Event channel not found');

    // Reset state
    state.valorData = {};
    state.userStats = {};
    state.lastEvent = { id: null, timestamp: null, host: null };

    let lastId = null;
    let allMessages = [];

    // Keep fetching messages until we get them all
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      allMessages = allMessages.concat(Array.from(messages.values()));
      lastId = messages.last().id;
    }

    // Sort messages by timestamp
    allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Process all messages
    allMessages.forEach(msg => {
      const { valorChanges, statChanges, eventId, eventHost } = parseEventMessage(msg.content);
      
      if (eventId) {
        state.lastEvent = { id: eventId, timestamp: msg.createdAt, host: eventHost };
      }

      valorChanges.forEach((change, userId) => {
        state.valorData[userId] = Math.max(0, (state.valorData[userId] || 0) + change);
      });

      statChanges.forEach((stats, userId) => {
        if (!state.userStats[userId]) {
          state.userStats[userId] = {
            eventsAttended: 0,
            inaCount: 0,
            doCount: 0,
            eventsHosted: 0
          };
        }
        
        Object.entries(stats).forEach(([key, value]) => {
          if (key !== 'valorChange') {
            state.userStats[userId][key] += value;
          }
        });
      });
    });

    state.lastUpdate = Date.now();
    await saveValorData();
    return true;
  } catch (error) {
    console.error('Error loading historical valor points:', error);
    return false;
  }
}

async function createLeaderboardEmbed(interaction, page = 1, itemsPerPage = 10) {
  const sortedPoints = Object.entries(state.valorData).sort(([, a], [, b]) => b - a);
  const totalPages = Math.ceil(sortedPoints.length / itemsPerPage);
  const startIndex = (page - 1) * itemsPerPage;
  const pageItems = sortedPoints.slice(startIndex, startIndex + itemsPerPage);

  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle('Valor Leaderboard')
    .setFooter({ text: `Page ${page}/${totalPages}` });

  if (pageItems.length === 0) {
    embed.setDescription('No valor points recorded yet!');
    return { embed, totalPages };
  }

  const description = await Promise.all(
    pageItems.map(async ([userId, points], index) => {
      try {
        await interaction.guild.members.fetch(userId);
        return `${startIndex + index + 1}. <@${userId}> | ${points} valor`;
      } catch {
        return null;
      }
    })
  );

  embed.setDescription(description.filter(Boolean).join('\n'));
  return { embed, totalPages };
}

// Command handlers with improved error handling
const commandHandlers = {
  async valor(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const points = state.valorData[targetUser.id] || 0;

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('Valor Points')
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: 'User', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Points', value: points.toString(), inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },

  async profile(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const stats = state.userStats[targetUser.id] || {
      eventsAttended: 0,
      inaCount: 0,
      doCount: 0,
      eventsHosted: 0
    };
    const points = state.valorData[targetUser.id] || 0;

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('Member Profile')
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: 'User', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Valor Points', value: points.toString(), inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        { name: 'Events Attended', value: stats.eventsAttended.toString(), inline: true },
        { name: 'Events Hosted', value: stats.eventsHosted.toString(), inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        { name: 'Incomplete Attendance (INA)', value: stats.inaCount.toString(), inline: true },
        { name: 'Disobeyed Orders (DO)', value: stats.doCount.toString(), inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },

  async leaderboard(interaction) {
    const { embed, totalPages } = await createLeaderboardEmbed(interaction, 1);
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('leaderboard_0')
          .setLabel('Previous')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('leaderboard_2')
          .setLabel('Next')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(totalPages <= 1)
      );

    await interaction.reply({ embeds: [embed], components: [row] });
  },

  async add(interaction) {
    const hasManageRole = state.config.manageValorRoleIds.some(roleId => 
      interaction.member.roles.cache.has(roleId)
    );

    if (!hasManageRole) {
      return interaction.reply({ 
        content: 'You need the required role to manage valor points!', 
        ephemeral: true 
      });
    }

    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (amount <= 0) {
      return interaction.reply({
        content: 'Please provide a positive number of valor points to add.',
        ephemeral: true
      });
    }

    state.valorData[targetUser.id] = (state.valorData[targetUser.id] || 0) + amount;
    await saveValorData();

    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('✅ Valor Points Added')
      .addFields(
        { name: 'User', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Amount Added', value: amount.toString(), inline: true },
        { name: 'New Total', value: state.valorData[targetUser.id].toString(), inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },

  async remove(interaction) {
    const hasManageRole = state.config.manageValorRoleIds.some(roleId => 
      interaction.member.roles.cache.has(roleId)
    );

    if (!hasManageRole) {
      return interaction.reply({ 
        content: 'You need the required role to manage valor points!', 
        ephemeral: true 
      });
    }

    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (amount <= 0) {
      return interaction.reply({
        content: 'Please provide a positive number of valor points to remove.',
        ephemeral: true
      });
    }

    const currentPoints = state.valorData[targetUser.id] || 0;
    state.valorData[targetUser.id] = Math.max(0, currentPoints - amount);
    await saveValorData();

    const embed = new EmbedBuilder()
      .setColor('#ff0000')
      .setTitle('✅ Valor Points Removed')
      .addFields(
        { name: 'User', value: `<@${targetUser.id}>`, inline: true },
        { name: 'Amount Removed', value: amount.toString(), inline: true },
        { name: 'New Total', value: state.valorData[targetUser.id].toString(), inline: true }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },

  async update(interaction) {
    const hasAdminRole = state.config.adminRoleIds.some(roleId => 
      interaction.member.roles.cache.has(roleId)
    );

    if (!hasAdminRole) {
      return interaction.reply({ 
        content: 'You need one of the required roles to use this command!', 
        ephemeral: true 
      });
    }

    await loadHistoricalValorPoints();
    const timeSince = Math.floor((Date.now() - state.lastUpdate) / 60000);
    
    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setTitle('✅ Valor Points Updated')
      .addFields(
        { 
          name: 'Last Update', 
          value: timeSince < 60 ? 
            `${timeSince} minutes ago` :
            timeSince < 1440 ? 
              `${Math.floor(timeSince / 60)} hours ago` :
              `${Math.floor(timeSince / 1440)} days ago`,
          inline: false 
        }
      );

    if (state.lastEvent.id) {
      const hostUser = state.lastEvent.host ? 
        await client.users.fetch(state.lastEvent.host) : 
        null;

      embed.addFields(
        { name: 'Last Event ID', value: state.lastEvent.id, inline: true },
        { name: 'Host', value: hostUser ? `<@${hostUser.id}>` : 'Unknown', inline: true },
        { name: 'Timestamp', value: new Date(state.lastEvent.timestamp).toLocaleString(), inline: true }
      );
    }

    await interaction.reply({ embeds: [embed] });
  }
};

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  // Set playing status
  client.user.setActivity('Roblox', { type: ActivityType.Playing });
  
  await Promise.all([
    setupCommands(client),
    loadHistoricalValorPoints()
  ]);
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton()) {
      const [action, page] = interaction.customId.split('_');
      if (action === 'leaderboard') {
        const newPage = parseInt(page);
        const { embed, totalPages } = await createLeaderboardEmbed(interaction, newPage);

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`leaderboard_${newPage - 1}`)
              .setLabel('Previous')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(newPage <= 1),
            new ButtonBuilder()
              .setCustomId(`leaderboard_${newPage + 1}`)
              .setLabel('Next')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(newPage >= totalPages)
          );

        await interaction.update({ embeds: [embed], components: [row] });
      }
      return;
    }

    if (interaction.isCommand()) {
      await commandHandlers[interaction.commandName]?.(interaction);
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    await interaction.reply({
      content: 'An error occurred while processing the command.',
      ephemeral: true
    }).catch(() => {});
  }
});

// Initialize and start with improved error handling
(async () => {
  try {
    if (await loadConfigAndData()) {
      await client.login(state.config.token);
    } else {
      console.error('Failed to initialize. Exiting...');
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error during initialization:', error);
    process.exit(1);
  }
})();
