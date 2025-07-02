// Import required dependencies
import express from 'express';
import cors from 'cors';
import Pusher from 'pusher';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

// Get current file path and directory (needed for ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Express app and set port
const app = express();
const PORT = process.env.PORT || 3001;

// Configure middleware
app.use(cors({
  // Set CORS origin based on environment - production uses Vercel domain, development uses localhost
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://443realtimedchat-cse443-thanees01s-projects.vercel.app'] // Replace with your actual Vercel domain
    : ['http://localhost:3001'],
  credentials: true // Allow credentials (cookies, authorization headers) to be sent
}));
app.use(express.json()); // Parse JSON request bodies
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from public directory

// Initialize Pusher for real-time communication
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER || 'ap1', // Default to Asia Pacific cluster
  useTLS: true // Use secure connections
});

// In-memory data storage (Note: This will reset on Vercel deployments)
// For production applications, consider using a persistent database like MongoDB, PostgreSQL, or Redis
let users = new Map(); // Store user data: userId -> user object
let groups = new Map(); // Store group data: groupId -> group object
let messages = new Map(); // Store messages: groupId -> array of messages
let polls = new Map(); // Store polls: groupId -> array of polls
let messageViews = new Map(); // Track message views: messageId -> array of userIds who viewed

// Initialize application with a default public group
const defaultGroupId = 'default-group-001';
groups.set(defaultGroupId, {
  id: defaultGroupId,
  name: 'General Chat',
  createdBy: 'system',
  createdAt: new Date(),
  isPrivate: false,
  members: [],
  onlineMembers: []
});
messages.set(defaultGroupId, []); // Initialize empty messages array for default group
polls.set(defaultGroupId, []); // Initialize empty polls array for default group

// Health check endpoint for Vercel deployment monitoring
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ==================== USER MANAGEMENT ENDPOINTS ====================

// User registration endpoint
app.post('/api/register', (req, res) => {
  const { username } = req.body;
  
  // Validate username input
  if (!username || username.trim().length === 0) {
    return res.status(400).json({ error: 'Username is required' });
  }
  
  // Check if username already exists (case-insensitive)
  const existingUser = Array.from(users.values()).find(user => 
    user.username.toLowerCase() === username.toLowerCase()
  );
  if (existingUser) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  
  // Create new user object
  const userId = uuidv4();
  const user = {
    id: userId,
    username: username.trim(),
    online: true,
    joinedAt: new Date(),
    currentGroup: null
  };
  
  // Store user in memory
  users.set(userId, user);
  
  // Return user credentials
  res.json({ userId, username: user.username });
});

// Update user online status (for returning users)
app.post('/api/user/online', (req, res) => {
  const { userId } = req.body;
  
  const user = users.get(userId);
  if (user) {
    user.online = true;
    res.json({ success: true, message: 'User is now online' });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// ==================== GROUP MANAGEMENT ENDPOINTS ====================

// Create a new group (public or private)
app.post('/api/groups', (req, res) => {
  const { groupName, createdBy, isPrivate = false, members = [] } = req.body;
  
  // Validate group name
  if (!groupName || groupName.trim().length === 0) {
    return res.status(400).json({ error: 'Group name is required' });
  }
  
  // Create new group object
  const groupId = uuidv4();
  const group = {
    id: groupId,
    name: groupName.trim(),
    createdBy,
    createdAt: new Date(),
    isPrivate,
    members: [createdBy, ...members], // Creator is automatically added to members
    onlineMembers: []
  };
  
  // Store group and initialize its messages and polls
  groups.set(groupId, group);
  messages.set(groupId, []);
  polls.set(groupId, []);
  
  // Notify all users about new public group via Pusher
  if (!isPrivate) {
    pusher.trigger('global', 'new-group', group);
  }
  
  res.json(group);
});

// Get all groups accessible to a user
app.get('/api/groups', (req, res) => {
  const { userId } = req.query;
  
  // Get all public groups
  const publicGroups = Array.from(groups.values()).filter(group => !group.isPrivate);
  
  // Get private groups where user is a member
  const userPrivateGroups = userId ? Array.from(groups.values()).filter(group => 
    group.isPrivate && group.members.includes(userId)
  ) : [];
  
  // Return combined list
  res.json([...publicGroups, ...userPrivateGroups]);
});

// Get specific group details
app.get('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params;
  const group = groups.get(groupId);
  
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  res.json(group);
});

// ==================== GROUP MEMBERSHIP ENDPOINTS ====================

// User joins a group
app.post('/api/groups/:groupId/join', (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.body;
  
  const group = groups.get(groupId);
  const user = users.get(userId);
  
  if (!group || !user) {
    return res.status(404).json({ error: 'Group or user not found' });
  }
  
  // Add user to group members if not already a member
  if (!group.members.includes(userId)) {
    group.members.push(userId);
  }
  
  // Add to online members list
  if (!group.onlineMembers.includes(userId)) {
    group.onlineMembers.push(userId);
  }
  
  // Update user's current group
  user.currentGroup = groupId;
  
  // Notify other group members that user joined
  pusher.trigger(`group-${groupId}`, 'user-joined', {
    user: { id: user.id, username: user.username },
    onlineCount: group.onlineMembers.length
  });
  
  res.json({ success: true, group });
});

// User leaves a group
app.post('/api/groups/:groupId/leave', (req, res) => {
  const { groupId } = req.params;
  const { userId } = req.body;
  
  const group = groups.get(groupId);
  const user = users.get(userId);
  
  if (!group || !user) {
    return res.status(404).json({ error: 'Group or user not found' });
  }
  
  // Remove user from online members
  group.onlineMembers = group.onlineMembers.filter(id => id !== userId);
  user.currentGroup = null;
  
  // Notify other group members that user left
  pusher.trigger(`group-${groupId}`, 'user-left', {
    userId,
    username: user.username,
    onlineCount: group.onlineMembers.length
  });
  
  res.json({ success: true });
});

// ==================== MESSAGING ENDPOINTS ====================

// Get all messages for a specific group
app.get('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const groupMessages = messages.get(groupId) || [];
  res.json(groupMessages);
});

// Send a new message to a group
app.post('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const { userId, content } = req.body;
  
  // Validate message content
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Message content is required' });
  }
  
  const user = users.get(userId);
  const group = groups.get(groupId);
  
  if (!user || !group) {
    return res.status(404).json({ error: 'User or group not found' });
  }
  
  // Create message object
  const message = {
    id: uuidv4(),
    userId,
    username: user.username,
    content: content.trim(),
    groupId,
    timestamp: new Date(),
    type: 'message'
  };
  
  // Store message in group's message history
  const groupMessages = messages.get(groupId) || [];
  groupMessages.push(message);
  messages.set(groupId, groupMessages);
  
  // Initialize view tracking for this message
  messageViews.set(message.id, []);
  
  // Broadcast message to all group members via Pusher
  pusher.trigger(`group-${groupId}`, 'new-message', message);
  
  res.json(message);
});

// ==================== POLLING ENDPOINTS ====================

// Get all polls for a specific group
app.get('/api/groups/:groupId/polls', (req, res) => {
  const { groupId } = req.params;
  const groupPolls = polls.get(groupId) || [];
  res.json(groupPolls);
});

// Create a new poll in a group
app.post('/api/groups/:groupId/polls', (req, res) => {
  const { groupId } = req.params;
  const { userId, question, options } = req.body;
  
  // Validate poll input
  if (!question || question.trim().length === 0) {
    return res.status(400).json({ error: 'Poll question is required' });
  }
  
  if (!options || options.length < 2) {
    return res.status(400).json({ error: 'At least 2 options are required' });
  }
  
  const user = users.get(userId);
  const group = groups.get(groupId);
  
  if (!user || !group) {
    return res.status(404).json({ error: 'User or group not found' });
  }
  
  // Create poll object with options
  const poll = {
    id: uuidv4(),
    userId,
    username: user.username,
    question: question.trim(),
    groupId,
    options: options.map(option => ({
      id: uuidv4(),
      text: option.trim(),
      votes: [], // Array of userIds who voted for this option
      count: 0
    })),
    timestamp: new Date(),
    type: 'poll'
  };
  
  // Store poll in group's poll history
  const groupPolls = polls.get(groupId) || [];
  groupPolls.push(poll);
  polls.set(groupId, groupPolls);
  
  // Broadcast new poll to group members
  pusher.trigger(`group-${groupId}`, 'new-poll', poll);
  
  res.json(poll);
});

// Vote on a poll option
app.post('/api/groups/:groupId/polls/:pollId/vote', (req, res) => {
  const { groupId, pollId } = req.params;
  const { userId, optionId } = req.body;
  
  const groupPolls = polls.get(groupId) || [];
  const poll = groupPolls.find(p => p.id === pollId);
  
  if (!poll) {
    return res.status(404).json({ error: 'Poll not found' });
  }
  
  // Remove user's previous vote from all options (users can only vote once)
  poll.options.forEach(option => {
    option.votes = option.votes.filter(id => id !== userId);
    option.count = option.votes.length;
  });
  
  // Add new vote to selected option
  const selectedOption = poll.options.find(opt => opt.id === optionId);
  if (selectedOption) {
    selectedOption.votes.push(userId);
    selectedOption.count = selectedOption.votes.length;
  }
  
  // Broadcast updated poll results to all group members
  pusher.trigger(`group-${groupId}`, 'poll-updated', poll);
  
  res.json(poll);
});

// ==================== MESSAGE VIEW TRACKING ENDPOINTS ====================

// Mark a message as viewed by a user
app.post('/api/messages/:messageId/view', (req, res) => {
  const { messageId } = req.params;
  const { userId } = req.body;
  
  if (!messageId || !userId) {
    return res.status(400).json({ error: 'Message ID and User ID are required' });
  }
  
  const viewers = messageViews.get(messageId) || [];
  
  // Add user to viewers list if not already viewing
  if (!viewers.includes(userId)) {
    viewers.push(userId);
    messageViews.set(messageId, viewers);
    
    // Get usernames of all viewers
    const viewerDetails = viewers
      .map(id => users.get(id))
      .filter(user => user) // Remove null/undefined users
      .map(user => user.username);
    
    // Find which group this message belongs to
    const message = Array.from(messages.values())
      .flat()
      .find(msg => msg.id === messageId);
    
    if (message) {
      // Broadcast view update to all users in the group
      pusher.trigger(`group-${message.groupId}`, 'message-viewed', {
        messageId,
        viewCount: viewerDetails.length,
        viewers: viewerDetails
      });
    }
  }
  
  res.json({ success: true });
});

// Get view information for a specific message
app.get('/api/messages/:messageId/views', (req, res) => {
  const { messageId } = req.params;
  const viewers = messageViews.get(messageId) || [];
  
  // Convert viewer IDs to usernames
  const viewerDetails = viewers
    .map(id => users.get(id))
    .filter(user => user)
    .map(user => user.username);
  
  res.json({
    messageId,
    viewCount: viewerDetails.length,
    viewers: viewerDetails
  });
});

// ==================== UTILITY ENDPOINTS ====================

// Get all users (useful for group creation and user management)
app.get('/api/users', (req, res) => {
  const userList = Array.from(users.values()).map(user => ({
    id: user.id,
    username: user.username,
    online: user.online
  }));
  res.json(userList);
});

// Get members of a specific group
app.get('/api/groups/:groupId/members', (req, res) => {
  const { groupId } = req.params;
  const group = groups.get(groupId);
  
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  
  // Map member IDs to user objects with online status
  const members = group.members.map(memberId => {
    const user = users.get(memberId);
    return user ? {
      id: user.id,
      username: user.username,
      online: group.onlineMembers.includes(memberId)
    } : null;
  }).filter(Boolean); // Remove null entries
  
  res.json(members);
});

// User logout endpoint
app.post('/api/logout', (req, res) => {
  const { userId } = req.body;
  const user = users.get(userId);
  
  if (user) {
    // Update user status
    user.online = false;
    user.currentGroup = null;
    
    // Remove user from all group online member lists and notify groups
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

// Add member to private group (admin functionality)
app.post('/api/groups/:groupId/add-member', (req, res) => {
  const { groupId } = req.params;
  const { userId, memberId } = req.body;
  
  const group = groups.get(groupId);
  const user = users.get(userId);
  const memberToAdd = users.get(memberId);
  
  if (!group || !user || !memberToAdd) {
    return res.status(404).json({ error: 'Group or user not found' });
  }
  
  // Check if user has permission to add members (only group creator)
  if (group.createdBy !== userId) {
    return res.status(403).json({ error: 'Only group creator can add members' });
  }
  
  // Add member to group if not already a member
  if (!group.members.includes(memberId)) {
    group.members.push(memberId);
    
    // Notify the new member about being added to the group
    pusher.trigger(`user-${memberId}`, 'added-to-group', {
      group,
      addedBy: user.username
    });
  }
  
  res.json({ success: true });
});

// Export the Express app for Vercel serverless deployment
export default app;

// Only start the server in development mode (not in Vercel production)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Open your chat app: http://localhost:${PORT}`);
    console.log('Make sure to set your Pusher credentials in .env file');
  });
}