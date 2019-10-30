import _ from 'lodash';
import { PostFrameUpdateType } from "../utils/slpReader";
import { FrameEntryType, FramesType, MoveLandedType, ComboType, PlayerIndexedType, SELF_DESTRUCT } from "./common";
import {
  isDamaged, isGrabbed, calcDamageTaken, isTeching, didLoseStock,
  Timers, isDown, isDead
} from "./common";
import { StatComputer } from './stats';

interface ComboState {
  combo: ComboType | null;
  move: MoveLandedType | null;
  resetCounter: number;
  lastAttacker: number;
  lastHitAnimation: number | null;
}

export class ComboComputer implements StatComputer<ComboType[]> {
  private playerPermutations = new Array<PlayerIndexedType>();
  private state = new Map<PlayerIndexedType, ComboState>();
  private combos = new Array<ComboType>();

  public setPlayerPermutations(playerPermutations: PlayerIndexedType[]): void {
    this.playerPermutations = playerPermutations;
    this.playerPermutations.forEach((indices) => {
      const playerState: ComboState = {
        combo: null,
        move: null,
        resetCounter: 0,
        lastAttacker: -1,
        lastHitAnimation: null,
      };
      this.state.set(indices, playerState);
    })
  }

  public processFrame(frame: FrameEntryType, allFrames: FramesType): void {
    this.playerPermutations.forEach((indices) => {
      const state = this.state.get(indices);
      handleComboCompute(allFrames, state, indices, frame, this.combos);
    });
  }

  public fetch(): ComboType[] {
    return this.combos;
  }

}

function handleComboCompute(frames: FramesType, state: ComboState, indices: PlayerIndexedType, frame: FrameEntryType, combos: ComboType[]): void {
  if (frame.players[indices.playerIndex] === undefined) {
    return;
  }
  const defenderFrame: PostFrameUpdateType = frame.players[indices.playerIndex].post;
  // FIXME: use type PostFrameUpdateType instead of any
  // This is because the default value {} should not be casted as a type of PostFrameUpdateType
  const prevDefenderFrame: any = _.get(
    frames, [defenderFrame.frame - 1, 'players', indices.playerIndex, 'post'], {}
  );

  const opntIsDamaged = isDamaged(defenderFrame.actionStateId);
  const opntIsGrabbed = isGrabbed(defenderFrame.actionStateId);
  const opntDamageTaken = calcDamageTaken(defenderFrame, prevDefenderFrame);

  // Keep track of whether actionState changes after a hit. Used to compute move count
  // When purely using action state there was a bug where if you did two of the same
  // move really fast (such as ganon's jab), it would count as one move. Added
  // the actionStateCounter at this point which counts the number of frames since
  // an animation started. Should be more robust, for old files it should always be
  // null and null < null = false
  const lastHitBy = defenderFrame.lastHitBy;
  if (state.lastAttacker !== -1) {
    // If the last attacker is still alive and it's the same as last frame, check if
    // the animation ended so we can stop tracking it.
    if (frame.players[state.lastAttacker] !== undefined && lastHitBy === state.lastAttacker) {
      var attackerFrame: PostFrameUpdateType = frame.players[lastHitBy].post;
      const prevAttackerFrame: any = _.get(
        frames, [attackerFrame.frame - 1, 'players', state.lastAttacker, 'post'], {}
      );

      const actionChangedSinceHit = attackerFrame.actionStateId !== state.lastHitAnimation;
      const actionCounter = attackerFrame.actionStateCounter;
      const prevActionCounter = prevAttackerFrame.actionStateCounter;
      const actionFrameCounterReset = actionCounter < prevActionCounter;
      if (actionChangedSinceHit || actionFrameCounterReset) {
        state.lastAttacker = -1;
        state.lastHitAnimation = null;
      }
    } else {
      // If the attacker died or changed, reset the animation counter.
      state.lastAttacker = -1;
      state.lastHitAnimation = null;
    }
  }

  // If opponent took damage and was put in some kind of stun this frame, either
  // start a combo or count the moves for the existing combo
  if (opntIsDamaged || opntIsGrabbed) {
    if (!state.combo) {
      state.combo = {
        playerIndex: lastHitBy,
        opponentIndex: indices.playerIndex,
        startFrame: defenderFrame.frame,
        endFrame: null,
        startPercent: prevDefenderFrame.percent || 0,
        currentPercent: defenderFrame.percent || 0,
        endPercent: null,
        moves: [],
        didKill: false,
      };

      combos.push(state.combo);
    }

    if (opntDamageTaken) {
      // If the attacker died since we were hit, just increment the damage.
      // Otherwise, try to track the animation.
      if (frame.players[lastHitBy] !== undefined) {
        var attackerFrame: PostFrameUpdateType = frame.players[lastHitBy].post;
        const prevAttackerFrame: any = _.get(
          frames, [attackerFrame.frame - 1, 'players', lastHitBy, 'post'], {}
        );

        // If the defender got grabbed first hit after respawning, lastHitBy will be
        // 6 (for SELF_DESTRUCT) until they get hit, so fix the combo's playerIndex accordingly.
        if (state.combo.playerIndex == SELF_DESTRUCT) {
          state.combo.playerIndex = lastHitBy;
        }

        // If animation of last hit has been cleared that means this is a new move. This
        // prevents counting multiple hits from the same move such as fox's drill
        if (!state.lastHitAnimation) {
          state.move = {
            frame: attackerFrame.frame,
            moveId: attackerFrame.lastAttackLanded,
            hitCount: 0,
            damage: 0,
          };

          state.combo.moves.push(state.move);
        }

        // Store previous frame animation to consider the case of a trade, the previous
        // frame should always be the move that actually connected... I hope
        state.lastAttacker = attackerFrame.playerIndex;
        state.lastHitAnimation = prevAttackerFrame.actionStateId;
      }

      if (state.move) {
        state.move.hitCount += 1;
        state.move.damage += opntDamageTaken;
      }
    }
  }

  if (!state.combo) {
    // The rest of the function handles combo termination logic, so if we don't
    // have a combo started, there is no need to continue
    return;
  }

  const opntIsTeching = isTeching(defenderFrame.actionStateId);
  const opntIsDowned = isDown(defenderFrame.actionStateId);
  const opntDidLoseStock = didLoseStock(defenderFrame, prevDefenderFrame);
  const opntIsDying = isDead(defenderFrame.actionStateId);

  // Update percent if opponent didn't lose stock
  if (!opntDidLoseStock) {
    state.combo.currentPercent = defenderFrame.percent || 0;
  }

  if (opntIsDamaged || opntIsGrabbed || opntIsTeching || opntIsDowned || opntIsDying) {
    // If opponent got grabbed or damaged, reset the reset counter
    state.resetCounter = 0;
  } else {
    state.resetCounter += 1;
  }

  let shouldTerminate = false;

  // Termination condition 1 - player kills opponent
  if (opntDidLoseStock) {
    state.combo.didKill = true;
    shouldTerminate = true;
  }

  // Termination condition 2 - combo resets on time
  if (state.resetCounter > Timers.COMBO_STRING_RESET_FRAMES) {
    shouldTerminate = true;
  }

  // If combo should terminate, mark the end states and add it to list
  if (shouldTerminate) {
    state.combo.endFrame = defenderFrame.frame;
    state.combo.endPercent = prevDefenderFrame.percent || 0;

    state.combo = null;
    state.move = null;
  }
}