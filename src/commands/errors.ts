import { error } from '../resp/types.js';
import type { RespValue } from '../resp/types.js';

export function wrongArgsError(command: string): RespValue {
  return error(`ERR wrong number of arguments for '${command.toLowerCase()}' command`);
}

export function unknownCommandError(command: string, args: string[]): RespValue {
  const argList = args.map((a) => `'${a}'`).join(', ');
  return error(`ERR unknown command '${command}', with args beginning with: ${argList}`);
}

export function notAuthenticatedError(): RespValue {
  return error('NOAUTH Authentication required.');
}

export function authNotRequiredError(): RespValue {
  return error('ERR Client sent AUTH, but no password is set.');
}

export function invalidPasswordError(): RespValue {
  return error('WRONGPASS invalid username-password pair or user is disabled.');
}

export function subscriberModeError(command: string): RespValue {
  return error(
    `ERR Can't execute '${command.toLowerCase()}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
  );
}

export function notAnIntegerReplyError(): RespValue {
  return error('ERR value is not an integer or out of range');
}

export function invalidExpireTimeError(command: string): RespValue {
  return error(`ERR invalid expire time in '${command.toLowerCase()}' command`);
}
