class RoomStore {
  constructor({ capacity, roomTtlMs, emptyRoomTtlMs }) {
    this.capacity = capacity;
    this.roomTtlMs = roomTtlMs;
    this.emptyRoomTtlMs = emptyRoomTtlMs;
    this.rooms = new Map();
  }

  createRoom(code) {
    const existingRoom = this.rooms.get(code);

    if (existingRoom) {
      this.touch(code);
      return existingRoom;
    }

    const room = {
      code,
      // Members are keyed by a stable per-tab participant ID, not by socket ID.
      // A reconnect or reload therefore replaces the stale socket instead of
      // consuming a second room slot and returning room-full.
      members: new Map(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  hasRoom(code) {
    return this.rooms.has(code);
  }

  touch(code) {
    const room = this.getRoom(code);

    if (room) {
      room.updatedAt = Date.now();
    }

    return room;
  }

  addMember(code, participantId, socketId) {
    const room = this.getRoom(code);

    if (!room) {
      return { ok: false, reason: 'room-not-found' };
    }

    const memberKey = participantId || socketId;
    const existingMember = room.members.get(memberKey);

    if (existingMember) {
      const replacedSocketId = existingMember.socketId;

      existingMember.socketId = socketId;
      existingMember.updatedAt = Date.now();
      this.touch(code);

      return {
        ok: true,
        room,
        isNew: false,
        replacedSocketId: replacedSocketId === socketId ? '' : replacedSocketId,
      };
    }

    if (room.members.size >= this.capacity) {
      return { ok: false, reason: 'room-full' };
    }

    room.members.set(memberKey, {
      participantId: memberKey,
      socketId,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.touch(code);

    return {
      ok: true,
      room,
      isNew: true,
      replacedSocketId: '',
    };
  }

  removeMember(code, participantId, socketId = '') {
    const room = this.getRoom(code);

    if (!room) {
      return { removed: false, room: null, deleted: false };
    }

    let memberKey = participantId;
    let member = room.members.get(memberKey);

    // Backward compatibility for a client that joined without a participant ID.
    if (!member && socketId) {
      for (const [key, candidate] of room.members.entries()) {
        if (candidate.socketId === socketId) {
          memberKey = key;
          member = candidate;
          break;
        }
      }
    }

    if (!member) {
      return { removed: false, room, deleted: false };
    }

    // The socket was already replaced by a newer connection for the same tab.
    // Its delayed disconnect must not remove the new live member.
    if (socketId && member.socketId !== socketId) {
      return { removed: false, room, deleted: false, stale: true };
    }

    room.members.delete(memberKey);
    room.updatedAt = Date.now();

    return { removed: true, room, deleted: false, member };
  }

  getMemberBySocketId(code, socketId) {
    const room = this.getRoom(code);

    if (!room) {
      return null;
    }

    for (const member of room.members.values()) {
      if (member.socketId === socketId) {
        return member;
      }
    }

    return null;
  }

  getPeerIds(code, excludeSocketId = null) {
    const room = this.getRoom(code);

    if (!room) {
      return [];
    }

    return Array.from(room.members.values())
      .map((member) => member.socketId)
      .filter((socketId) => socketId !== excludeSocketId);
  }

  isMember(code, socketId) {
    return Boolean(this.getMemberBySocketId(code, socketId));
  }

  getSize(code) {
    const room = this.getRoom(code);
    return room ? room.members.size : 0;
  }

  cleanupStaleRooms(now = Date.now()) {
    let deletedCount = 0;

    for (const [code, room] of this.rooms.entries()) {
      const roomAge = now - room.updatedAt;

      if (room.members.size === 0 && roomAge > this.emptyRoomTtlMs) {
        this.rooms.delete(code);
        deletedCount += 1;
      }
    }

    return deletedCount;
  }
}

module.exports = { RoomStore };
