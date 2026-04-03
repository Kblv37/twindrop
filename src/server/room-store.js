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
      members: new Set(),
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

  addMember(code, socketId) {
    const room = this.getRoom(code);

    if (!room) {
      return { ok: false, reason: 'room-not-found' };
    }

    if (room.members.has(socketId)) {
      this.touch(code);
      return { ok: true, room };
    }

    if (room.members.size >= this.capacity) {
      return { ok: false, reason: 'room-full' };
    }

    room.members.add(socketId);
    this.touch(code);

    return { ok: true, room };
  }

  removeMember(code, socketId) {
    const room = this.getRoom(code);

    if (!room) {
      return { removed: false, room: null, deleted: false };
    }

    const removed = room.members.delete(socketId);

    if (!removed) {
      return { removed: false, room, deleted: false };
    }

    room.updatedAt = Date.now();

    return { removed: true, room, deleted: false };
  }

  getPeerIds(code, excludeSocketId = null) {
    const room = this.getRoom(code);

    if (!room) {
      return [];
    }

    return Array.from(room.members).filter((socketId) => socketId !== excludeSocketId);
  }

  isMember(code, socketId) {
    const room = this.getRoom(code);
    return Boolean(room && room.members.has(socketId));
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
