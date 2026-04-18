/**
 * sql_pipeline.js — Alert query pipeline (phase: idle).
 * Classify → generate SQL → fetch alerts → accumulate shownAlerts → summarise.
 *
 * (C) 2020 TekMonks. All rights reserved.
 */

const db = require(`${APP_CONSTANTS.LIB_DIR}/db.js`);
const { callLLMJson, callLLMText } = require(`${APP_CONSTANTS.LIB_DIR}/llmcall.js`);
const { parseRecoveryIds, formatAlertsForDisplay } = require(`${APP_CONSTANTS.LIB_DIR}/alert_utils.js`);
const session_utils = require(`${APP_CONSTANTS.LIB_DIR}/session.js`);

const TMPL_CLASSIFY = "chatbot_classify";
const TMPL_SQL      = "chatbot_sql";

const MSG_RECOVERY_QUESTION = "\n\nWould you like me to apply automated recovery to all of these, or a specific one?";

const INTENT_OFF_TOPIC       = "off_topic";
const INTENT_RECOVERY_REQUEST = "recovery_request";

const MSG_OFF_TOPIC = "I can only help with alert queries on this monitoring platform. " +
                         "Try asking something like 'show me recent errors' or 'list alerts from the last hour'.", 
MSG_UNSAFE_SQL = "I could not build a safe query for that request. Please rephrase.",
MSG_NO_ALERTS = "No alerts found matching your query. Try a different time range or search term.";

/**
 * Run the alert query pipeline for phase=idle.
 * @param {string} message
 * @param {object} session
 * @returns {object} chatbot response
 */
async function runAlertPipeline(message, session) {
    // STEP 1: classify — alert query, recovery request, or off-topic?
    const cls = await callLLMJson(TMPL_CLASSIFY, { message }, session.chatHistory);
    if (!cls || cls.intent === INTENT_OFF_TOPIC) {
        return session_utils.reply(message, MSG_OFF_TOPIC, session);
    }
    const isRecoveryRequest = cls.intent === INTENT_RECOVERY_REQUEST;

    // STEP 2: generate SQL from natural language
    const currentTimestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    const sql = (await callLLMText(TMPL_SQL, { message, currentTimestamp }, session.chatHistory)).trim();
    if (!_isSafeSQL(sql)) {
        LOG.error(`Chatbot unsafe SQL blocked: ${sql}`);
        return session_utils.reply(message, MSG_UNSAFE_SQL, session);
    }

    // STEP 3: run SQL against monboss.db
    const rows = await db.getQuery(sql, []);
    if (!rows || rows.length === 0)
        return session_utils.reply(message, MSG_NO_ALERTS, session);

    // STEP 4: accumulate into shownAlerts (keyed by issue_id, no duplicates)
    for (const row of rows) {
        const issue_id = row.issue_id || "IID-LEGACY";
        if (session.shownAlerts.find(a => a.issue_id === issue_id)) continue;
        session.shownAlerts.push({
            issue_id,
            timestamp:       row.timestamp      || "",
            error:           row.error          || "",
            additional_err:  row.additional_err || "",
            system:          row.system         || "",
            rephrased_alert: row.rephrased_alert || "",
            recoveryIds:     parseRecoveryIds(row.recovery_chain_ids)
        });
    }

    // STEP 5: format and display alerts directly using rephrased_alert
    const newAlerts   = rows.map(r => session.shownAlerts.find(a => a.issue_id === (r.issue_id || "IID-LEGACY")));
    const hasRecovery = newAlerts.some(a => a.recoveryIds.length > 0);
    const response    = formatAlertsForDisplay(newAlerts) + (hasRecovery ? MSG_RECOVERY_QUESTION : "");

    session.phase = (isRecoveryRequest || hasRecovery) ? session_utils.PHASE_AWAITING_INTENT : session_utils.PHASE_IDLE;
    return session_utils.reply(message, response, session);
}

function _isSafeSQL(sql) {
    const upperSQL = sql.trim().toUpperCase();
    if (!upperSQL.startsWith("SELECT")) return false;
    for (const blockedKeyword of ["DROP", "DELETE", "UPDATE", "INSERT", "ATTACH", "PRAGMA", "--", "/*"])
        if (upperSQL.includes(blockedKeyword)) return false;
    return true;
}

module.exports = { runAlertPipeline };