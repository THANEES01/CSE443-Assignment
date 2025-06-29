import express from 'express';
import cors from 'cors';
import Pusher from 'pusher';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// In-memory storage (use database in production)
let users = new Map(); // userId -> user object
let groups = new Map(); // groupId -> group object
let messages = new Map(); // groupId -> messages array
let polls = new Map(); // groupId -> polls array
let messageViews = new Map(); // messageId -> [userId]

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chat/:groupId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/groups', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'groups.html'));
});

// User Management
app.post('/api/register', (req, res) => {
  const { username } = req.body;
  
  // Check if username already exists
  const existingUser = Array.from(users.values()).find(user => user.username === username);
  if (existingUser) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  
  const userId = uuidv4();
  const user = {
    id: userId,
    username,
    online: true,
    joinedAt: new Date(),
    currentGroup: null
  };
  
  users.set(userId, user);
  
  res.json({ userId, username });
});

// Group Management
app.post('/api/groups', (req, res) => {
  const { groupName, createdBy, isPrivate = false, members = [] } = req.body;
  
  const groupId = uuidv4();
  const group = {
    id: groupId,
    name: groupName,
    createdBy,
    createdAt: new Date(),
    isPrivate,
    members: [createdBy, ...members],
    onlineMembers: []
  };
  
  groups.set(groupId, group);
  messages.set(groupId, []);
  polls.set(groupId, []);
  
  // Notify all users about new public group
  if (!isPrivate) {
    pusher.trigger('global', 'new-group', group);
  }
  
  res.json(group);
});

app.get('/api/groups', (req, res) => {
  const { userId } = req.query;
  const publicGroups = Array.from(groups.values()).filter(group => !group.isPrivate);
  const userPrivateGroups = Array.from(groups.values()).filter(group => 
    group.isPrivate && group.members.includes(userId)
  );
  
  res.json([...publicGroups, ...userPrivateGroups]);
});

app.get('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params;
  const group = groups.get(groupId);
  
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  res.json(group);
});

// Join/Leave Group
app.post('/api/groups/:groupId/join', (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.body;
  
  const group = groups.get(groupId);
  const user = users.get(userId);
  
  if (!group || !user) {
    return res.status(404).json({ error: 'Group or user not found' });
  }
  
  // Add user to group if not already a member
  if (!group.members.includes(userId)) {
    group.members.push(userId);
  }
  
  // Add to online members
  if (!group.onlineMembers.includes(userId)) {
    group.onlineMembers.push(userId);
  }
  
  user.currentGroup = groupId;
  
  // Notify group members
  pusher.trigger(`group-${groupId}`, 'user-joined', {
    user: { id: user.id, username: user.username },
    onlineCount: group.onlineMembers.length
  });
  
  res.json({ success: true, group });
});

app.post('/api/groups/:groupId/leave', (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.body;
  
  const group = groups.get(groupId);
  const user = users.get(userId);
  
  if (!group || !user) {
    return res.status(404).json({ error: 'Group or user not found' });
  }
  
  // Remove from online members
  group.onlineMembers = group.onlineMembers.filter(id => id !== userId);
  user.currentGroup = null;
  
  // Notify group members
  pusher.trigger(`group-${groupId}`, 'user-left', {
    userId,
    username: user.username,
    onlineCount: group.onlineMembers.length
  });
  
  res.json({ success: true });
});

// Messages
app.get('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const groupMessages = messages.get(groupId) || [];
  res.json(groupMessages);
});

app.post('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const { userId, content } = req.body;
  
  const user = users.get(userId);
  const group = groups.get(groupId);
  
  if (!user || !group) {
    return res.status(404).json({ error: 'User or group not found' });
  }
  
  const message = {
    id: uuidv4(),
    userId,
    username: user.username,
    content,
    groupId,
    timestamp: new Date(),
    type: 'message'
  };
  
  const groupMessages = messages.get(groupId) || [];
  groupMessages.push(message);
  messages.set(groupId, groupMessages);
  
  messageViews.set(message.id, []);
  
  // Broadcast to group
  pusher.trigger(`group-${groupId}`, 'new-message', message);
  
  res.json(message);
});

// Polls
app.get('/api/groups/:groupId/polls', (req, res) => {
  const { groupId } = req.params;
  const groupPolls = polls.get(groupId) || [];
  res.json(groupPolls);
});

app.post('/api/groups/:groupId/polls', (req, res) => {
  const { groupId } = req.params;
  const { userId, question, options } = req.body;
  
  const user = users.get(userId);
  const group = groups.get(groupId);
  
  if (!user || !group) {
    return res.status(404).json({ error: 'User or group not found' });
  }
  
  const poll = {
    id: uuidv4(),
    userId,
    username: user.username,
    question,
    groupId,
    options: options.map(option => ({
      id: uuidv4(),
      text: option,
      votes: [],
      count: 0
    })),
    timestamp: new Date(),
    type: 'poll'
  };
  
  const groupPolls = polls.get(groupId) || [];
  groupPolls.push(poll);
  polls.set(groupId, groupPolls);
  
  // Broadcast to group
  pusher.trigger(`group-${groupId}`, 'new-poll', poll);
  
  res.json(poll);
});

app.post('/api/groups/:groupId/polls/:pollId/vote', (req, res) => {
  const { groupId, pollId } = req.params;
  const { userId, optionId } = req.body;
  
  const groupPolls = polls.get(groupId) || [];
  const poll = groupPolls.find(p => p.id === pollId);
  
  if (!poll) {
    return res.status(404).json({ error: 'Poll not found' });
  }
  
  // Remove previous vote if exists
  poll.options.forEach(option => {
    option.votes = option.votes.filter(id => id !== userId);
    option.count = option.votes.length;
  });
  
  // Add new vote
  const selectedOption = poll.options.find(opt => opt.id === optionId);
  if (selectedOption) {
    selectedOption.votes.push(userId);
    selectedOption.count = selectedOption.votes.length;
  }
  
  // Broadcast updated poll
  pusher.trigger(`group-${groupId}`, 'poll-updated', poll);
  
  res.json(poll);
});

// Message Views
app.post('/api/messages/:messageId/view', (req, res) => {
  const { messageId } = req.params;
  const { userId } = req.body;
  
  const viewers = messageViews.get(messageId) || [];
  
  if (!viewers.includes(userId)) {
    viewers.push(userId);
    messageViews.set(messageId, viewers);
    
    // Get usernames for viewers
    const viewerDetails = viewers
      .map(id => users.get(id))
      .filter(user => user)
      .map(user => user.username);
    
    // Find which group this message belongs to
    const message = Array.from(messages.values())
      .flat()
      .find(msg => msg.id === messageId);
    
    if (message) {
      pusher.trigger(`group-${message.groupId}`, 'message-viewed', {
        messageId,
        viewCount: viewerDetails.length,
        viewers: viewerDetails
      });
    }
  }
  
  res.json({ success: true });
});

// Get all users (for group creation)
app.get('/api/users', (req, res) => {
  const userList = Array.from(users.values()).map(user => ({
    id: user.id,
    username: user.username,
    online: user.online
  }));
  res.json(userList);
});

// Get group members
app.get('/api/groups/:groupId/members', (req, res) => {
  const { groupId } = req.params;
  const group = groups.get(groupId);
  
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  const members = group.members.map(memberId => {
    const user = users.get(memberId);
    return user ? {
      id: user.id,
      username: user.username,
      online: group.onlineMembers.includes(memberId)
    } : null;
  }).filter(Boolean);
  
  res.json(members);
});

// User logout
app.post('/api/logout', (req, res) => {
  const { userId } = req.body;
  const user = users.get(userId);
  
  if (user) {
    user.online = false;
    user.currentGroup = null;
    
    // Remove from all group online members
    groups.forEach(group => {
      if (group.onlineMembers.includes(userId)) {
        group.onlineMembers = group.onlineMembers.filter(id => id !== userId);
        pusher.trigger(`group-${group.id}`, 'user-left', {
          userId,
          username: user.username,
          onlineCount: group.onlineMembers.length
        });
      }
    });
  }
  
  res.json({ success: true });
});

// Add member to private group
app.post('/api/groups/:groupId/add-member', (req, res) => {
  const { groupId } = req.params;
  const { userId, memberId } = req.body;
  
  const group = groups.get(groupId);
  const user = users.get(userId);
  const memberToAdd = users.get(memberId);
  
  if (!group || !user || !memberToAdd) {
    return res.status(404).json({ error: 'Group or user not found' });
  }
  
  // Check if user is group creator or admin
  if (group.createdBy !== userId) {
    return res.status(403).json({ error: 'Only group creator can add members' });
  }
  
  // Add member if not already in group
  if (!group.members.includes(memberId)) {
    group.members.push(memberId);
    
    // Notify the new member
    pusher.trigger(`user-${memberId}`, 'added-to-group', {
      group,
      addedBy: user.username
    });
  }
  
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Open your chat app: http://localhost:${PORT}`);
  console.log('Make sure to set your Pusher credentials in .env file');
});