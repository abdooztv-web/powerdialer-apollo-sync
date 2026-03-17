const axios = require('axios');
const logger = require('../utils/logger');

const APOLLO_API_BASE = 'https://api.apollo.io/v1';

function getHeaders() {
  return {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key':     process.env.APOLLO_API_KEY
  };
}

// Extracts the real error message from an Apollo API error response
function apolloError(error) {
  const body    = error.response?.data;
  const status  = error.response?.status;
  const message = body?.message || body?.error || body?.error_description
    || (Array.isArray(body?.errors) ? body.errors.join(', ') : null)
    || error.message;
  const err = new Error(`Apollo ${status}: ${message}`);
  err.apolloBody   = body;
  err.apolloStatus = status;
  return err;
}

async function findContactByEmail(email) {
  try {
    const response = await axios.post(
      `${APOLLO_API_BASE}/contacts/search`,
      { q_keywords: email, per_page: 1 },
      { headers: getHeaders() }
    );
    const contacts = response.data.contacts || [];
    return contacts.find(c => c.email === email) || null;
  } catch (error) {
    logger.error('findContactByEmail failed', { email, status: error.response?.status, body: error.response?.data });
    throw apolloError(error);
  }
}

async function addToSequence(contactId, sequenceId) {
  const emailAccountId = process.env.APOLLO_EMAIL_ACCOUNT_ID;

  if (!emailAccountId) {
    throw new Error('APOLLO_EMAIL_ACCOUNT_ID is not set in environment variables. Go to Vercel → Settings → Environment Variables and add it.');
  }

  try {
    const response = await axios.post(
      `${APOLLO_API_BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`,
      {
        contact_ids:                       [contactId],
        emailer_campaign_id:               sequenceId,
        send_email_from_email_account_id:  emailAccountId
      },
      { headers: getHeaders() }
    );
    return response.data;
  } catch (error) {
    logger.error('addToSequence failed', {
      contactId,
      sequenceId,
      emailAccountId,
      status: error.response?.status,
      body:   error.response?.data
    });
    throw apolloError(error);
  }
}

async function removeFromSequences(contactId, reason) {
  try {
    const response = await axios.post(
      `${APOLLO_API_BASE}/emailer_campaigns/remove_or_stop_contact_ids`,
      { contact_ids: [contactId] },
      { headers: getHeaders() }
    );
    return response.data;
  } catch (error) {
    logger.error('removeFromSequences failed', {
      contactId,
      status: error.response?.status,
      body:   error.response?.data
    });
    throw apolloError(error);
  }
}

module.exports = { findContactByEmail, addToSequence, removeFromSequences };
