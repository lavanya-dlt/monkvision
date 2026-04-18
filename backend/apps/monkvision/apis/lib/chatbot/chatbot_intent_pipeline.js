/**
 * intent_pipeline.js — Intent detection pipeline (phase: awaiting_intent).
 * Approve / deny / specific alert / new query / unrelated.
 *
 * (C) 2020 TekMonks. All rights reserved.
 */

const db                                        = require(`${APP_CONSTANTS.LIB_DIR}/db.js`);
const { callLLMJson }                           = require(`${APP_CONSTANTS.LIB_DIR}/llmcall.js`);
const { parseRecoveryIds, formatShownAlertsSummary, allRecoveryIds } = require(`${APP_CONSTANTS.LIB_DIR}/alert_utils.js`);
const { callRecovery }                          = require(`${APP_CONSTANTS.LIB_DIR}/recovery_utils.js`);
const session_utils                             = require(`${APP_CONSTANTS.LIB_DIR}/session.js`);

const SQL_FETCH_BY_ISSUE_IDS = ids => `SELECT issue_id, timestamp, error, additional_err, system, rephrased_alert, recovery_chain_ids FROM alerts WHERE issue_id IN (${ids.map(() => "?").join(",")})`;

const INTENT_APPROVE         = "approve";
const INTENT_DENY            = "deny";
const INTENT_SPECIFIC_ALERT  = "specific_alert";
const INTENT_NEW_QUERY       = "new_alert_query";

const TMPL_INTENT            = "chatbot_intent";
const TMPL_RESOLVE_WHICH     = "chatbot_resolve_which";

const MSG_APPROVE_OK         = ids => `Approved. Initiating automated recovery for ${ids.map(id => `issue [${id}]`).join(", ")}.`;
const MSG_APPROVE_NO_PLAN    = "Noted — but none of the issues I showed you have an automated recovery plan attached. No action taken.";
const MSG_DENY_OK            = "Understood. Recovery has been denied. No automated action will be taken.";
const MSG_SPECIFIC_UNCLEAR   = "I'm not sure which issue you're referring to. " +
                               "You can reference it by ID — e.g. 'resolve [IID-A1B2C3]' — or describe it more specifically.";
const MSG_NO_RECOVERY_PLAN   = ids => `${ids.map(id => `Issue [${id}]`).join(", ")} ${ids.length > 1 ? "don't have" : "doesn't have"} an automated recovery plan attached. Nothing to run.`;
const MSG_RECOVERY_APPROVED  = ids => `On it. Running automated recovery for ${ids.map(id => `issue [${id}]`).join(", ")}.`;
const MSG_UNRELATED          = "Sorry, I need a clear response: yes to proceed with recovery, no to skip, " +
                               "or you can ask about a different alert.";

/**
 * Run the intent detection pipeline for phase=awaiting_intent.
 * @param {string} message
 * @param {object} session
 * @param {Function} runAlertPipeline — passed in to avoid circular require
 * @returns {object} chatbot response
 */
async function runIntentPipeline(message, session, runAlertPipeline) {
    const intent = await callLLMJson(TMPL_INTENT, { message }, session.chatHistory);
    const kind   = intent && intent.intent;

    // Approve ALL shown alerts
    if (kind === INTENT_APPROVE) {
        const allIds    = allRecoveryIds(session.shownAlerts);
        const issueIds  = session.shownAlerts.filter(alert => alert.recoveryIds.length > 0).map(alert => alert.issue_id);
        if (allIds.length) await callRecovery("approved", allIds);
        session.phase = session_utils.PHASE_IDLE;
        return session_utils.reply(message, allIds.length ? MSG_APPROVE_OK(issueIds) : MSG_APPROVE_NO_PLAN, session);
    }

    // Deny ALL shown alerts
    if (kind === INTENT_DENY) {
        const allIds = allRecoveryIds(session.shownAlerts);
        if (allIds.length) await callRecovery("denied", allIds);
        session.phase = session_utils.PHASE_IDLE;
        return session_utils.reply(message, MSG_DENY_OK, session);
    }

    // Resolve a specific alert by issue ID or description
    if (kind === INTENT_SPECIFIC_ALERT) {
        const alertsSummary = formatShownAlertsSummary(session.shownAlerts);
        const which    = await callLLMJson(TMPL_RESOLVE_WHICH, { message, shownAlertsSummary: alertsSummary });
        const issueIds = (which && Array.isArray(which.issueIds)) ? which.issueIds : [];

        if (issueIds.length === 0) {
            return session_utils.reply(message, MSG_SPECIFIC_UNCLEAR, session);
        }

        // Fetch any issue IDs from DB that aren't already in shownAlerts (e.g. seen on left panel)
        await _fetchMissingAlertsIntoSession(issueIds, session);

        const matchedIds = session.shownAlerts
            .filter(alert => issueIds.includes(alert.issue_id))
            .flatMap(alert => alert.recoveryIds);

        if (matchedIds.length === 0) {
            return session_utils.reply(message, MSG_NO_RECOVERY_PLAN(issueIds), session);
        }

        await callRecovery("approved", matchedIds);
        session.phase = session_utils.PHASE_IDLE;
        return session_utils.reply(message, MSG_RECOVERY_APPROVED(issueIds), session);
    }

    // User asking about different/new alerts — reset and re-run alert pipeline
    if (kind === INTENT_NEW_QUERY) {
        session.phase = session_utils.PHASE_IDLE;
        return await runAlertPipeline(message, session);
    }

    // Unrelated — stay in awaiting_intent and re-prompt
    return session_utils.reply(message, MSG_UNRELATED, session);
}

/**
 * For each issueId not already in session.shownAlerts, fetch from DB and add it.
 * This allows users to reference alerts seen on the left panel without having
 * queried them through the chatbot first.
 * @param {string[]} issueIds
 * @param {object} session
 */
async function _fetchMissingAlertsIntoSession(issueIds, session) {
    const missingIds = issueIds.filter(issueId => !session.shownAlerts.find(alert => alert.issue_id === issueId));
    if (!missingIds.length) return;

    const rows = await db.getQuery(SQL_FETCH_BY_ISSUE_IDS(missingIds), missingIds);
    if (!rows || rows.length === 0) return;

    for (const row of rows) {
        session.shownAlerts.push({
            issue_id:        row.issue_id,
            timestamp:       row.timestamp       || "",
            error:           row.error           || "",
            additional_err:  row.additional_err  || "",
            system:          row.system          || "",
            rephrased_alert: row.rephrased_alert || "",
            recoveryIds:     parseRecoveryIds(row.recovery_chain_ids)
        });
    }
}

module.exports = { runIntentPipeline };