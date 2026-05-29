import { AuthUser } from '../common/decorators/current-user.decorator';
import { ActorType } from '../common/enums';

export interface ActorContext {
  actorType: ActorType;
  actorId: number | null;
}

export const SYSTEM_ACTOR: ActorContext = {
  actorType: ActorType.SYSTEM,
  actorId: null,
};

// Controllers build their ActorContext from the JWT-derived AuthUser via
// this helper, then thread it into services. Services never touch req.user
// or AuthUser directly — keeping HTTP details out of the service layer.
export function actorFrom(user: AuthUser): ActorContext {
  return { actorType: ActorType.USER, actorId: user.userId };
}
