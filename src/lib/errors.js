'use strict';
// A rule the user broke (shown as a message, not a crash).
class RuleError extends Error {
  constructor(message, details) { super(message); this.name = 'RuleError'; this.details = details || []; this.status = 400; }
}
class Forbidden extends Error { constructor(message = 'You do not have permission for this action.') { super(message); this.status = 403; } }
class NotFound extends Error { constructor(message = 'Not found.') { super(message); this.status = 404; } }
function rule(cond, message) { if (!cond) throw new RuleError(message); }
module.exports = { RuleError, Forbidden, NotFound, rule };
