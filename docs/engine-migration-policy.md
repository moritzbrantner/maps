# Engine migration policy

Migration is responsibility-oriented. A responsibility moves only when the first-party subsystem is useful end to end and proven against its adopted contract. Avoid long-lived shadow implementations after authority transfer. Temporary reference paths must be clearly labeled and removable. Compatibility wrappers may preserve public API shape, but they must not preserve obsolete internal ownership.
