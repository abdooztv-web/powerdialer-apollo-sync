/**
 * Apollo Configuration
 * Define your sequence mappings here
 */

const PASTORS_SEQUENCE_ID = process.env.PASTORS_SEQUENCE_ID || '693bf8101177c400190c7168';
const DIRECTORS_SEQUENCE_ID = process.env.DIRECTORS_SEQUENCE_ID || '68df994e01bcfc001d51f6ba';
const NEW_SEQUENCE_ID = process.env.NEW_SEQUENCE_ID || '69af119c98528e0011c32d0a';

/**
 * Maps PowerDialer dispositions to Apollo actions
 *
 * action: 'add' | 'remove' | 'none'
 * sequenceId: Apollo sequence ID (only needed for 'add' action)
 * sequenceName: Human-readable name for logging
 */
const DISPOSITION_MAP = {
  'Interested': {
    action: 'add',
    sequenceId: PASTORS_SEQUENCE_ID,
    sequenceName: 'Pastors High Positions'
  },
  'Very Interested': {
    action: 'add',
    sequenceId: PASTORS_SEQUENCE_ID,
    sequenceName: 'Pastors High Positions'
  },
  'Hot Lead': {
    action: 'add',
    sequenceId: PASTORS_SEQUENCE_ID,
    sequenceName: 'Pastors High Positions'
  },
  'Callback Requested': {
    action: 'add',
    sequenceId: DIRECTORS_SEQUENCE_ID,
    sequenceName: 'Directors High Positions'
  },
  'Callback': {
    action: 'add',
    sequenceId: DIRECTORS_SEQUENCE_ID,
    sequenceName: 'Directors High Positions'
  },
  'Not Interested': {
    action: 'remove',
    sequenceId: null,
    sequenceName: 'Remove from all sequences'
  },
  'Wrong Number': {
    action: 'remove',
    sequenceId: null,
    sequenceName: 'Remove from all sequences'
  },
  'Invalid Number': {
    action: 'remove',
    sequenceId: null,
    sequenceName: 'Remove from all sequences'
  },
  'Meeting Scheduled': {
    action: 'remove',
    sequenceId: null,
    sequenceName: 'Remove from all sequences (Won!)'
  },
  'Demo Scheduled': {
    action: 'remove',
    sequenceId: null,
    sequenceName: 'Remove from all sequences (Won!)'
  },
  'Left Voicemail': {
    action: 'none',
    sequenceId: null,
    sequenceName: 'No action'
  },
  'No Answer': {
    action: 'none',
    sequenceId: null,
    sequenceName: 'No action'
  },
  'Busy': {
    action: 'none',
    sequenceId: null,
    sequenceName: 'No action'
  }
};

module.exports = {
  DISPOSITION_MAP,
  PASTORS_SEQUENCE_ID,
  DIRECTORS_SEQUENCE_ID,
  NEW_SEQUENCE_ID
};
