// Friendly names are aliases only: the server remains the source of tool schemas.
const aliases = Object.freeze({
  'profile': ['pipa_profile', false, false],
  'lists': ['pipa_lists', false, false],
  'tasks list': ['pipa_tasks_search', false, false],
  'tasks search': ['pipa_tasks_search', false, false],
  'tasks get': ['pipa_task_get', false, true],
  'tasks create': ['pipa_task_create', true, false],
  'tasks update': ['pipa_task_update', true, true],
  'tasks complete': ['pipa_task_complete', true, true],
  'tasks delete': ['pipa_task_delete', true, true],
  'tasks restore': ['pipa_task_restore', true, true],
  'tasks schedule': ['pipa_task_schedule', true, true],
  'tasks recurrence set': ['pipa_task_recurrence_set', true, true],
  'tasks recurrence remove': ['pipa_task_recurrence_remove', true, true],
  'tasks reminder set': ['pipa_reminder_set', true, true],
  'tasks reminder remove': ['pipa_reminder_remove', true, true],
  'notes list': ['pipa_notes_search', false, false],
  'notes search': ['pipa_notes_search', false, false],
  'notes get': ['pipa_note_get', false, true],
  'notes create': ['pipa_note_create', true, false],
  'notes update': ['pipa_note_update', true, true],
  'notes delete': ['pipa_note_delete', true, true],
  'notes restore': ['pipa_note_restore', true, true],
})

export const knownWriteTools = new Set(Object.values(aliases).filter((item) => item[1]).map((item) => item[0]))
export const commandNames = Object.freeze(Object.keys(aliases))

export function resolveAlias(tokens) {
  // Longest match first so "tasks recurrence set" is not a partial command.
  for (let length = tokens.length; length > 0; length--) {
    const name = tokens.slice(0, length).join(' ')
    if (!Object.prototype.hasOwnProperty.call(aliases, name)) continue
    const [tool, mutation, acceptsId] = aliases[name]
    const rest = tokens.slice(length)
    if (rest.length > (acceptsId ? 1 : 0)) return null
    return { name, tool, mutation, id: rest[0] }
  }
  return null
}
