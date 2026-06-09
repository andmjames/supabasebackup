'use strict';

const TZ = 'America/Indiana/Indianapolis';

/**
 * Current wall-clock time in Eastern, broken into the parts we schedule on.
 * @returns {{dayOfWeek:number, hour:number, minute:number, dateStr:string}}
 *   dayOfWeek: 0=Sun .. 6=Sat
 */
function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const m = {};
  for (const p of parts) m[p.type] = p.value;

  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(m.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds emit "24" at midnight

  return {
    dayOfWeek: wd[m.weekday],
    hour,
    minute: parseInt(m.minute, 10),
    dateStr: `${m.year}-${m.month}-${m.day}`,
  };
}

module.exports = { easternParts, TZ };
