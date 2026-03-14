require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { handleDisposition } = require('./handlers/disposition');
const logger = require('./utils/logger');
const { addEvent, getEvents, getStats } = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors());
app.use(express.json());

// Serve dashboard UI
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/webhook', limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'PowerDialer → Apollo sync is running',
    timestamp: new Date().toISOString()
  });
});

// Activity API for dashboard
app.get('/api/activity', (req, res) => {
  res.json({
    success: true,
    stats: getStats(),
    events: getEvents()
  });
});

// Main webhook endpoint for PowerDialer
app.post('/webhook/powerdialer', async (req, res) => {
  const startTime = Date.now();
  const { contact_email, disposition, contact_name, notes, timestamp } = req.body;

  logger.info('📞 Received webhook', {
    contact_email,
    disposition,
    contact_name,
    timestamp
  });

  if (!contact_email || !disposition) {
    logger.error('❌ Missing required fields', { body: req.body });
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: contact_email and disposition are required'
    });
  }

  try {
    const result = await handleDisposition({
      contactEmail: contact_email,
      disposition: disposition,
      contactName: contact_name,
      notes: notes,
      timestamp: timestamp
    });

    const duration = Date.now() - startTime;
    logger.info(`✅ Successfully processed in ${duration}ms`, {
      contact_email,
      disposition,
      action: result.action
    });

    addEvent({
      contactName: contact_name || 'Unknown',
      contactEmail: contact_email,
      disposition: disposition,
      action: result.action,
      sequenceName: result.sequenceName || null,
      success: true,
      error: null
    });

    res.json({
      success: true,
      message: result.message,
      contact: contact_email,
      disposition: disposition,
      action: result.action,
      processingTime: `${duration}ms`
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('❌ Error processing webhook', {
      error: error.message,
      contact_email,
      disposition,
      stack: error.stack,
      duration: `${duration}ms`
    });

    addEvent({
      contactName: contact_name || 'Unknown',
      contactEmail: contact_email,
      disposition: disposition,
      action: 'error',
      sequenceName: null,
      success: false,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: error.message,
      contact: contact_email,
      suggestion: error.suggestion || 'Check server logs for details'
    });
  }
});

// Test endpoint
app.post('/webhook/test', async (req, res) => {
  logger.info('🧪 Test webhook called', req.body);

  addEvent({
    contactName: req.body.contact_name || 'Test User',
    contactEmail: req.body.contact_email || 'test@example.com',
    disposition: req.body.disposition || 'Test',
    action: 'test',
    sequenceName: null,
    success: true,
    error: null
  });

  res.json({
    success: true,
    message: 'Test webhook received successfully',
    receivedData: req.body
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.listen(PORT, () => {
  logger.info(`🚀 Webhook server running on port ${PORT}`);
  logger.info(`📡 Webhook URL: http://localhost:${PORT}/webhook/powerdialer`);
  logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
  logger.info(`📊 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
