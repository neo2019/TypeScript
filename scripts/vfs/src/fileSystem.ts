import * as events from "events";
import * as constants from "./constants";
import * as vpath from "@typescript/vfs-path";
import * as core from "@typescript/vfs-core";
import { IOError } from "@typescript/vfs-errors";

const _throw = (e: any) => { throw e; };

const IN_MASK = constants.IN_ALL_EVENTS | constants.IN_EXCL_UNLINK | constants.IN_ONESHOT;
const IN_RENAME = constants.IN_ALL_EVENTS & ~(constants.IN_ATTRIB | constants.IN_MODIFY);
const RW_OK = constants.R_OK | constants.W_OK;
const RWX_OK = constants.R_OK | constants.W_OK | constants.X_OK;

let devCount = 0; // A monotonically increasing count of device ids
let inoCount = 0; // A monotonically increasing count of inodes
let fdCount = 0; // A monotonically increasing count of file descriptors
let wdCount = 0; // A monotonically increasing count of watch descriptors
let cookieCount = 0; // A monotonically increasing count of watch event cookies

/**
 * Represents a virtual POSIX-like file system.
 */
export class FileSystem {
    public readonly ignoreCase: boolean;
    public readonly stringComparer: (a: string, b: string) => number;

    private static _portableFilenameCharSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";

    // lazy-initialized state that should be mutable even if the FileSystem is frozen.
    private _lazy: {
        links?: core.SortedMap<string, Inode>;
        watchedFiles?: core.SortedMap<string, Set<WatchedFile>>;
        meta?: core.Metadata;
    } = {};

    private _cwd: string;
    private _uid: number;
    private _gid: number;
    private _umask: number;
    private _time: number | Date | (() => number | Date);
    private _timers: FileSystemTimers;
    private _openFiles = new Map<number, OpenFileDescription | InotifyDescription>();
    private _shadowRoot: FileSystem | undefined;
    private _dirStack: string[] | undefined;

    constructor(ignoreCase: boolean, options: FileSystemOptions = {}) {
        const { uid = 0, gid = 0, umask = 0o022, time = -1, timers, files, meta } = options;
        this.ignoreCase = ignoreCase;
        this.stringComparer = this.ignoreCase ? vpath.compareCaseInsensitive : vpath.compareCaseSensitive;
        this._uid = uid;
        this._gid = gid;
        this._umask = umask;
        this._time = time;
        this._timers = timers || { setInterval, clearInterval };

        if (meta) {
            for (const key of Object.keys(meta)) {
                this.meta.set(key, meta[key]);
            }
        }

        if (files) {
            this._applyFiles(files, /*dirname*/ "");
        }

        let cwd = options.cwd;
        if ((!cwd || !vpath.isRoot(cwd)) && this._lazy.links) {
            for (const name of this._lazy.links.keys()) {
                cwd = cwd ? vpath.resolve(name, cwd) : name;
                break;
            }
        }

        if (cwd) {
            vpath.validate(cwd, vpath.ValidationFlags.Absolute);
            this.mkdirpSync(cwd, /*mode*/ 0o777);
        }

        this._cwd = cwd || "";
    }

    /**
     * Gets metadata for this `FileSystem`.
     */
    public get meta(): core.Metadata {
        if (!this._lazy.meta) {
            this._lazy.meta = new core.Metadata(this._shadowRoot ? this._shadowRoot.meta : undefined);
        }
        return this._lazy.meta;
    }

    /**
     * Gets a value indicating whether the file system is read-only.
     */
    public get isReadonly() {
        return Object.isFrozen(this);
    }

    /**
     * Makes the file system read-only.
     */
    public makeReadonly() {
        Object.freeze(this);
        return this;
    }

    /**
     * Gets the file system shadowed by this file system.
     */
    public get shadowRoot() {
        return this._shadowRoot;
    }

    /**
     * Gets a shadow of this file system.
     */
    public shadow(ignoreCase = this.ignoreCase) {
        if (!this.isReadonly) throw new Error("Cannot shadow a mutable file system.");
        if (ignoreCase && !this.ignoreCase) throw new Error("Cannot create a case-insensitive file system from a case-sensitive one.");
        const fs = new FileSystem(ignoreCase, {
            uid: this._uid,
            gid: this._gid,
            umask: this._umask,
            time: this._time,
        });
        fs._shadowRoot = this;
        fs._cwd = this._cwd;
        return fs;
    }

    /**
     * Gets the metadata object for a path.
     * @param path
     */
    public filemeta(path: string): core.Metadata {
        path = this._resolve(path);
        const { node } = this._find(path) || _throw(new IOError("ENOENT", "scandir", path));
        return this._filemeta(node);
    }

    private _filemeta(node: Inode): core.Metadata {
        if (!node.meta) {
            const parentMeta = node.shadowRoot && this._shadowRoot && this._shadowRoot._filemeta(node.shadowRoot);
            node.meta = new core.Metadata(parentMeta);
        }
        return node.meta;
    }

    /**
     * Gets the user ID to use for file system access.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/getuid.html
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/geteuid.html
     */
    public getuid() {
        return this._uid;
    }

    /**
     * Sets the user ID to use for file system access.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/setuid.html
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/seteuid.html
     */
    public setuid(value: number) {
        if (this.isReadonly) throw new IOError("EPERM", "setuid");
        this._uid = value;
    }

    /**
     * Gets the group ID to use for file system access.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/getgid.html
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/getegid.html
     */
    public getgid() {
        return this._gid;
    }

    /**
     * Sets the group ID to use for file system access.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/setgid.html
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/setegid.html
     */
    public setgid(value: number) {
        if (this.isReadonly) throw new IOError("EPERM", "setgid");
        this._gid = value;
    }

    /**
     * Gets or sets the virtual process's file mode creation mask (umask)
     * to `mask & 0o777` and returns the previous value of the mask.
     *
     * @link http://man7.org/linux/man-pages/man2/umask.2.html
     */
    public umask(value?: number): number {
        if (value !== undefined && this.isReadonly) throw new IOError("EPERM", "umask");
        const result = this._umask;
        if (value !== undefined) {
            this._umask = value;
        }
        return result;
    }

    /**
     * Gets or sets the timestamp (in milliseconds) used for file status, returning the previous timestamp.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/time.html
     */
    public time(value?: number | Date | (() => number | Date)): number {
        if (value !== undefined && this.isReadonly) throw new IOError("EPERM");
        let result = this._time;
        if (typeof result === "function") result = result();
        if (typeof result === "object") result = result.getTime();
        if (result === -1) result = Date.now();
        if (value !== undefined) {
            this._time = value;
        }
        return result;
    }

    /**
     * Get the pathname of the current working directory.
     *
     * @link - http://pubs.opengroup.org/onlinepubs/9699919799/functions/getcwd.html
     */
    public cwd() {
        if (!this._cwd) throw new Error("The current working directory has not been set.");
        const { node } = this._find(this._cwd) || _throw(new IOError("ENOENT", "getcwd"));
        if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "getcwd");
        if (!this._access(node, constants.X_OK)) throw new IOError("EPERM", "getcwd");
        return this._cwd;
    }

    /**
     * Changes the current working directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chdir.html
     */
    public chdir(path: string) {
        if (this.isReadonly) throw new IOError("EPERM", "chdir", path);
        path = this._resolve(path);
        const { node } = this._find(path) || _throw(new IOError("ENOENT", "chdir", path));
        if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "chdir", path);
        if (this._cwd !== path) {
            this._cwd = path;
        }
    }

    /**
     * Pushes the current directory onto the directory stack and changes the current working directory to the supplied path.
     */
    public pushd(path?: string) {
        if (this.isReadonly) throw new IOError("EPERM", "chdir", path);
        if (path) path = this._resolve(path);
        if (this._cwd) {
            if (!this._dirStack) this._dirStack = [];
            this._dirStack.push(this._cwd);
        }
        if (path && path !== this._cwd) {
            this.chdir(path);
        }
    }

    /**
     * Pops the previous directory from the location stack and changes the current directory to that directory.
     */
    public popd() {
        if (this.isReadonly) throw new IOError("EPERM", "popd");
        const path = this._dirStack && this._dirStack.pop();
        if (path) {
            this.chdir(path);
        }
    }

    /**
     * Apply a file map to the file system.
     */
    public apply(files: FileMap) {
        this._applyFiles(files, this._cwd);
    }

    /**
     * Recursively remove all files and directories underneath the provided path.
     */
    public rimrafSync(path: string) {
        try {
            const stats = this.lstatSync(path);
            if (stats.isFile() || stats.isSymbolicLink()) {
                this.unlinkSync(path);
            }
            else if (stats.isDirectory()) {
                for (const file of this.readdirSync(path)) {
                    this.rimrafSync(vpath.combine(path, file));
                }
                this.rmdirSync(path);
            }
        }
        catch (e) {
            if (e.code === "ENOENT") return;
            throw e;
        }
    }

    /**
     * Checks whether the calling process can access the file `path`. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/access.html
     */
    public access(path: string, callback: (err: Error | null) => void): void;
    /**
     * Checks whether the calling process can access the file `path`. If `path` is a symbolic link, it is dereferenced.
     * @param mode One or more of the constants `F_OK`, `R_OK`, `W_OK`, or `X_OK`.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/access.html
     */
    public access(path: string, mode: number | undefined, callback: (err: Error | null) => void): void;
    public access(path: string, mode: number | typeof callback, callback?: (err: Error | null) => void) {
        if (typeof mode === "function") callback = mode, mode = undefined;
        if (!callback) throw new IOError("EINVAL");
        try {
            this.accessSync(path, mode);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Checks whether the calling process can access the file `path`. If `path` is a symbolic link, it is dereferenced.
     * @param mode One or more of the constants `F_OK`, `R_OK`, `W_OK`, or `X_OK`.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/access.html
     */
    public accessSync(path: string, mode: number = constants.F_OK) {
        path = this._resolve(path);
        if (!isFinite(mode) || (mode & ~RWX_OK)) throw new IOError("EINVAL", "access", path);
        const { node } = this._find(path) || _throw(new IOError("ENOENT", "access", path));
        if (!this._access(node, mode)) throw new IOError("EACCES", "access", path);
    }

    private _access(node: Inode, mode: number) {
        let flags = (node.mode & constants.S_IRWXO) >> 0;
        if (this.getgid() === node.gid) flags |= (node.mode & constants.S_IRWXG) >> 3;
        if (this.getuid() === node.uid) flags |= (node.mode & constants.S_IRWXU) >> 6;
        return (flags & mode) === mode;
    }

    /**
     * Changes the permissions of a file. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chmod.html
     */
    public chmod(path: string, mode: number, callback: (err: Error | null) => void) {
        try {
            this.chmodSync(path, mode);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Changes the permissions of a file. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chmod.html
     */
    public chmodSync(path: string, mode: number) {
        path = this._resolve(path);
        this._chmod("chmod", this._find(path) || _throw(new IOError("ENOENT", "chmod", path)), mode, path);
    }

    /**
     * Changes the permissions of a file. Like `chmod`, except symbolic links are not dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chmod.html
     */
    public lchmod(path: string, mode: number, callback: (err: Error | null) => void) {
        try {
            this.lchmodSync(path, mode);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Changes the permissions of a file. Like `chmod`, except symbolic links are not dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chmod.html
     */
    public lchmodSync(path: string, mode: number) {
        path = this._resolve(path);
        this._chmod("lchmod", this._lfind(path) || _throw(new IOError("ENOENT", "lchmod", path)), mode, path);
    }

    /**
     * Changes the permissions of an open file
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/fchmod.html
     */
    public fchmod(fd: number, mode: number, callback: (err: Error | null) => void) {
        try {
            this.fchmodSync(fd, mode);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Changes the permissions of an open file
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/fchmod.html
     */
    public fchmodSync(fd: number, mode: number) {
        this._chmod("fchmod", this._file("fchmod", fd, "open"), mode);
    }

    private _chmod(syscall: string, entry: FileDescription, mode: number, path?: string) {
        if (!isFinite(mode)) throw new IOError("EINVAL", syscall, path);
        if (this._uid !== 0 && this._uid !== entry.node.uid) throw new IOError("EPERM", syscall, path);
        if (this.isReadonly) throw new IOError("EROFS", syscall, path);

        entry.node.mode = (entry.node.mode & constants.S_IFMT) | (mode & 0o7777);
        entry.node.ctimeMs = this.time();

        this._notify(entry.parent, constants.IN_ATTRIB, entry.basename);
        this._notify(entry.node, constants.IN_ATTRIB, entry.basename);
    }

    /**
     * Changes the ownership of a file. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chown.html
     */
    public chown(path: string, uid: number, gid: number, callback: (err: Error | null) => void) {
        try {
            this.chownSync(path, uid, gid);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Changes the ownership of a file. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/chown.html
     */
    public chownSync(path: string, uid: number, gid: number) {
        path = this._resolve(path);
        this._chown("chown", this._find(path) || _throw(new IOError("ENOENT", "chown", path)), uid, gid, path);
    }

    /**
     * Changes the ownership of a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/lchown.html
     */
    public lchown(path: string, uid: number, gid: number, callback: (err: Error | null) => void) {
        try {
            this.lchownSync(path, uid, gid);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Changes the ownership of a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/lchown.html
     */
    public lchownSync(path: string, uid: number, gid: number) {
        path = this._resolve(path);
        this._chown("lchown", this._lfind(path) || _throw(new IOError("ENOENT", "lchown", path)), uid, gid, path);
    }

    /**
     * Changes the ownership of an open file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/fchown.html
     */
    public fchown(fd: number, uid: number, gid: number, callback: (err: Error | null) => void) {
        try {
            this.fchownSync(fd, uid, gid);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Changes the ownership of an open file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/fchown.html
     */
    public fchownSync(fd: number, uid: number, gid: number) {
        this._chown("fchown", this._file("fchown", fd, "open"), uid, gid);
    }

    private _chown(syscall: string, entry: FileDescription, uid: number, gid: number, path?: string) {
        if (!isFinite(uid) || !isFinite(gid)) throw new IOError("EINVAL", syscall, path);
        if (uid === entry.node.uid) uid = -1;
        if (gid === entry.node.gid) gid = -1;
        if (uid === -1 && gid === -1) return;
        if (uid !== -1 && this._uid !== 0) throw new IOError("EPERM", syscall, path);
        if (gid !== -1 && this._uid !== 0 && this._uid !== entry.node.uid) throw new IOError("EPERM", syscall, path);
        if (this.isReadonly) throw new IOError("EROFS", syscall, path);

        if (uid !== -1) entry.node.uid = uid;
        if (gid !== -1) entry.node.gid = gid
        entry.node.mode &= ~(constants.S_ISGID | constants.S_ISUID);
        entry.node.ctimeMs = this.time();

        this._notify(entry.parent, constants.IN_ATTRIB, entry.basename);
        this._notify(entry.node, constants.IN_ATTRIB, entry.basename);
    }

    /**
     * Sets file access and modification times. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/utimes.html
     */
    public utimes(path: string, atime: number | Date, mtime: number | Date, callback: (err: Error | null) => void) {
        try {
            this.utimesSync(path, atime, mtime);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Sets file access and modification times. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/utimes.html
     */
    public utimesSync(path: string, atime: number | Date, mtime: number | Date) {
        path = this._resolve(path);
        this._utimes("utimes", this._find(path) || _throw(new IOError("ENOENT", "utimes", path)), atime, mtime, path);
    }

    /**
     * Sets file access and modification times. If `path` is a symbolic link, it is not dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/utimes.html
     */
    public lutimes(path: string, atime: number | Date, mtime: number | Date, callback: (err: Error | null) => void) {
        try {
            this.lutimesSync(path, atime, mtime);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Sets file access and modification times. If `path` is a symbolic link, it is not dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/utimes.html
     */
    public lutimesSync(path: string, atime: number | Date, mtime: number | Date) {
        path = this._resolve(path);
        this._utimes("lutimes", this._lfind(path) || _throw(new IOError("ENOENT", "lutimes", path)), atime, mtime, path);
    }

    /**
     * Sets file access and modification times.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/futimes.html
     */
    public futimes(fd: number, atime: number | Date, mtime: number | Date, callback: (err: Error | null) => void) {
        try {
            this.futimesSync(fd, atime, mtime);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Sets file access and modification times.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/futimes.html
     */
    public futimesSync(fd: number, atime: number | Date, mtime: number | Date) {
        this._utimes("futimes", this._file("futimes", fd, "open"), atime, mtime);
    }

    private _utimes(syscall: string, entry: FileDescription, atime: number | Date, mtime: number | Date, path?: string) {
        if (this.isReadonly) throw new IOError("EROFS", syscall, path);
        const atimeMs = typeof atime === "number" ? atime : atime.getTime();
        const mtimeMs = typeof mtime === "number" ? mtime : mtime.getTime();
        if (!isFinite(atimeMs) || !isFinite(mtimeMs)) throw new IOError("EINVAL", syscall, path);

        entry.node.atimeMs = atimeMs;
        entry.node.mtimeMs = mtimeMs;
        entry.node.ctimeMs = this.time();

        this._notify(entry.parent, constants.IN_ATTRIB, entry.basename);
        this._notify(entry.node, constants.IN_ATTRIB, entry.basename);
    }

    public fsync(fd: number, callback: (err: Error | null) => void): void {
        try {
            this.fsyncSync(fd);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    public fsyncSync(fd: number): void {
        this._fsync(this._file("fsync", fd, "open", "file"), /*metadata*/ true);
    }

    public fdatasync(fd: number, callback: (err: Error | null) => void): void {
        try {
            this.fdatasyncSync(fd);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    public fdatasyncSync(fd: number): void {
        this._fsync(this._file("fsyncdata", fd, "open", "file"), /*metadata*/ false);
    }

    private _fsync(entry: OpenFileDescription, metadata: boolean) {
        if (isFileInode(entry.node) && entry.buffer && entry.buffer !== entry.node.buffer) {
            const timestamp = this.time();
            entry.node.buffer = entry.buffer;
            entry.node.mtimeMs = timestamp;
            entry.node.ctimeMs = timestamp;
            if (metadata) {
                entry.node.size = entry.node.buffer.byteLength;
            }
            this._notify(entry.parent, constants.IN_MODIFY, entry.basename);
            this._notify(entry.node, constants.IN_MODIFY, entry.basename);
        }
    }

    /**
     * Get file status. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/stat.html
     */
    public stat(path: string, callback: (err: Error | null, stats: Stats | null) => void) {
        try {
            process.nextTick(callback, null, this.statSync(path));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Get file status. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/stat.html
     */
    public statSync(path: string) {
        path = this._resolve(path);
        return this._stat("stat", this._find(path) || _throw(new IOError("ENOENT", "stat", path)), path);
    }

    /**
     * Get file status.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/lstat.html
     */
    public lstat(path: string, callback: (err: Error | null, stats: Stats | null) => void) {
        try {
            process.nextTick(callback, null, this.lstatSync(path));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Get file status.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/lstat.html
     */
    public lstatSync(path: string) {
        path = this._resolve(path);
        return this._stat("lstat", this._lfind(path) || _throw(new IOError("ENOENT", "lstat", path)), path);
    }

    /**
     * Get file status.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/fstat.html
     */
    public fstat(fd: number, callback: (err: Error | null, stats: Stats | null) => void) {
        try {
            process.nextTick(callback, null, this.fstatSync(fd));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Get file status.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/fstat.html
     */
    public fstatSync(fd: number) {
        return this._stat("fstat", this._file("fstat", fd, "open"));
    }

    private _stat(syscall: string, entry: FileDescription, path?: string) {
        const node = entry.node;
        return new Stats(
            node.dev,
            node.ino,
            node.mode,
            node.nlink,
            node.uid,
            node.gid,
            /*rdev*/ 0,
            /*size*/ isFileInode(node) ? this._getSize(node) : isSymlinkInode(node) ? node.symlink.length : 0,
            /*blksize*/ 4096,
            /*blocks*/ 0,
            node.atimeMs,
            node.mtimeMs,
            node.ctimeMs,
            node.birthtimeMs,
        );
    }

    public scanSync(path: string, axis: Axis, traversal: Traversal) {
        path = this._resolve(path);
        const results: string[] = [];
        this._scan(path, this.statSync(path), axis, traversal, /*noFollow*/ false, results);
        return results;
    }

    public lscanSync(path: string, axis: Axis, traversal: Traversal) {
        path = this._resolve(path);
        const results: string[] = [];
        this._scan(path, this.statSync(path), axis, traversal, /*noFollow*/ true, results);
        return results;
    }

    private _scan(path: string, stats: Stats, axis: Axis, traversal: Traversal, noFollow: boolean, results: string[]) {
        if (axis === "ancestors-or-self" || axis === "self" || axis === "descendants-or-self") {
            if (!traversal.accept || traversal.accept(path, stats)) {
                results.push(path);
            }
        }
        if (axis === "ancestors-or-self" || axis === "ancestors") {
            const dirname = vpath.dirname(path);
            if (dirname !== path) {
                try {
                    const stats = this._stat("scandir", this._walk(dirname, noFollow) || _throw(new IOError("ENOENT", "scandir", dirname)));
                    if (!traversal.traverse || traversal.traverse(dirname, stats)) {
                        this._scan(dirname, stats, "ancestors-or-self", traversal, noFollow, results);
                    }
                }
                catch { /*ignored*/ }
            }
        }
        if (axis === "descendants-or-self" || axis === "descendants") {
            if (stats.isDirectory() && (!traversal.traverse || traversal.traverse(path, stats))) {
                for (const file of this.readdirSync(path)) {
                    try {
                        const childpath = vpath.combine(path, file);
                        const stats = this._stat("scandir", this._walk(childpath, noFollow) || _throw(new IOError("ENOENT", "scandir", childpath)));
                        this._scan(childpath, stats, "descendants-or-self", traversal, noFollow, results);
                    }
                    catch { /*ignored*/ }
                }
            }
        }
    }

    /**
     * Read a directory. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readdir.html
     */
    public readdir(path: string, callback: (err: Error | null, files: string[] | null) => void) {
        try {
            process.nextTick(callback, null, this.readdirSync(path));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Read a directory. If `path` is a symbolic link, it is dereferenced.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readdir.html
     */
    public readdirSync(path: string) {
        path = this._resolve(path);
        const { node } = this._find(path) || _throw(new IOError("ENOENT", "readdir", path));
        if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "readdir", path);
        if (!this._access(node, constants.R_OK)) throw new IOError("EACCES", "readdir", path);
        return Array.from(this._getLinks(node).keys());
    }

    /**
     * Mounts a physical or virtual file system at a location in this virtual file system.
     *
     * @param source The path in the physical (or other virtual) file system.
     * @param target The path in this virtual file system.
     * @param resolver An object used to resolve files in `source`.
     */
    public mount(source: string, target: string, resolver: FileSystemResolver, callback: (err: Error | null) => void): void;
    /**
     * Mounts a physical or virtual file system at a location in this virtual file system.
     *
     * @param source The path in the physical (or other virtual) file system.
     * @param target The path in this virtual file system.
     * @param resolver An object used to resolve files in `source`.
     */
    public mount(source: string, target: string, resolver: FileSystemResolver, mode: number | undefined, callback: (err: Error | null) => void): void;
    public mount(source: string, target: string, resolver: FileSystemResolver, mode: number | typeof callback, callback?: (err: Error | null) => void) {
        if (typeof mode === "function") callback = mode, mode = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            this.mountSync(source, target, resolver, mode);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Mounts a physical or virtual file system at a location in this virtual file system.
     *
     * @param source The path in the physical (or other virtual) file system.
     * @param target The path in this virtual file system.
     * @param resolver An object used to resolve files in `source`.
     */
    public mountSync(source: string, target: string, resolver: FileSystemResolver, mode = 0o777) {
        source = vpath.validate(source, vpath.ValidationFlags.Absolute);
        target = this._resolve(target);
        mode = mode & 0o1777; // allows S_ISVTX bit

        let parent: DirectoryInode | undefined;
        let links: core.SortedMap<string, Inode>;
        let name: string;

        // special case for FS root
        if (this.stringComparer(vpath.dirname(target), target) === 0) {
            if (this.getuid() !== 0) throw new IOError("EPERM", "mount", source, target);
            name = target;
            links = this._getRootLinks();
        }
        else {
            const entry = this._find(vpath.dirname(target)) || _throw(new IOError("ENOENT", "mount", source, target));
            if (!isDirectoryInode(entry.node)) throw new IOError("ENOTDIR", "mount", source, target);
            if (!this._access(entry.node, constants.W_OK)) throw new IOError("EACCES", "mount", source, target);
            parent = entry.node;
            name = vpath.basename(target);
            links = this._getLinks(parent);
        }

        if (links.has(name)) throw new IOError("EEXIST", "mount", source, target);
        if (this.isReadonly) throw new IOError("EROFS", "mount", source, target);

        const node = parent
            ? this._mknod(parent.dev, constants.S_IFDIR, mode)
            : this._mknod(++devCount, constants.S_IFDIR, mode, /*uid*/ 0, /*gid*/ 0, /*umask*/ 0o000);

        node.source = source;
        node.resolver = resolver;

        links.set(name, node);

        if (parent) {
            parent.mtimeMs = this.time();
            this._notify(parent, constants.IN_CREATE | constants.IN_ISDIR, name);
        }
        else if (!this._cwd) {
            this._cwd = name;
        }
    }

    /**
     * Make a directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkdir.html
     */
    public mkdir(path: string, callback: (error: Error | null) => void): void;
    /**
     * Make a directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkdir.html
     */
    public mkdir(path: string, mode: number | undefined, callback: (error: Error | null) => void): void;
    public mkdir(path: string, mode: number | typeof callback, callback?: (error: Error | null) => void) {
        if (typeof mode === "function") callback = mode, mode = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            this.mkdirSync(path, mode);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Make a directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkdir.html
     */
    public mkdirSync(path: string, mode: number = 0o777) {
        path = this._resolve(path);
        if (!isFinite(mode)) throw new IOError("EINVAL", "mkdir", path);
        mode = mode & 0o1777; // allows S_ISVTX bit

        let parent: DirectoryInode | undefined;
        let links: core.SortedMap<string, Inode>;
        let name: string;

        // special case for FS root
        if (this.stringComparer(vpath.dirname(path), path) === 0) {
            if (this.getuid() !== 0) throw new IOError("EPERM", "mkdir", path);
            name = path;
            links = this._getRootLinks();
        }
        else {
            const parentEntry = this._find(vpath.dirname(path)) || _throw(new IOError("ENOENT", "mkdir", path));
            if (!isDirectoryInode(parentEntry.node)) throw new IOError("ENOTDIR", "mkdir", path);
            if (!this._access(parentEntry.node, constants.W_OK)) throw new IOError("EACCES", "mkdir", path);
            parent = parentEntry.node;
            name = vpath.basename(path);
            links = this._getLinks(parent);
        }

        if (links.has(name)) throw new IOError("EEXIST", "mkdir", path);
        if (this.isReadonly) throw new IOError("EROFS", "mkdir", path);

        const node = parent
            ? this._mknod(parent.dev, constants.S_IFDIR, mode)
            : this._mknod(++devCount, constants.S_IFDIR, mode, /*uid*/ 0, /*gid*/ 0, /*umask*/ 0o000);

        links.set(name, node);

        if (parent) {
            parent.mtimeMs = this.time();
            if (parent.mode & constants.S_ISGID) {
                node.mode |= constants.S_ISGID;
                node.gid = parent.gid;
            }
            this._notify(parent, constants.IN_CREATE | constants.IN_ISDIR, name);
        }
        else if (!this._cwd) {
            this._cwd = name;
        }
    }

    /**
     * Make a directory and all of its parent paths (if they don't exist).
     */
    public mkdirp(path: string, callback: (error: Error | null) => void): void;
    /**
     * Make a directory and all of its parent paths (if they don't exist).
     */
    public mkdirp(path: string, mode: number | undefined, callback: (error: Error | null) => void): void;
    public mkdirp(path: string, mode: number | typeof callback, callback?: (error: Error | null) => void) {
        if (typeof mode === "function") callback = mode, mode = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            this.mkdirpSync(path, mode);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Make a directory and all of its parent paths (if they don't exist).
     */
    public mkdirpSync(path: string, mode: number = 0o777) {
        path = this._resolve(path);
        try {
            this.mkdirSync(path, mode);
        }
        catch (e) {
            if (e.code === "ENOENT") {
                this.mkdirpSync(vpath.dirname(path), mode);
                this.mkdirSync(path, mode);
            }
            else if (e.code !== "EEXIST") {
                throw e;
            }
        }
    }

    /**
     * Remove a directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rmdir.html
     */
    public rmdir(path: string, callback: (err: Error | null) => void) {
        try {
            this.rmdirSync(path);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Remove a directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rmdir.html
     */
    public rmdirSync(path: string) {
        path = this._resolve(path);

        const { parent, node, basename } = this._find(path) || _throw(new IOError("ENOENT", "rmdir", path));
        if (!isDirectoryInode(node)) throw new IOError("ENOTDIR", "rmdir", path);
        if (this._getLinks(node).size !== 0) throw new IOError("ENOTEMPTY", "rmdir", path);
        if (!this._access(parent, constants.W_OK)) throw new IOError("EACCES", "mkdir", path);
        if (this.isReadonly) throw new IOError("EROFS", "rmdir", path);

        this._getLinks(parent).delete(vpath.basename(path));
        parent.mtimeMs = this.time();

        node.nlink--;
        node.ctimeMs = this.time();

        this._notify(parent, constants.IN_DELETE | constants.IN_ISDIR, basename);
        this._notify(node, constants.IN_DELETE_SELF, basename);

        if (node.nlink === 0) {
            this._inotifyRemoveAllWatches(node);
        }
    }

    /**
     * Link one file to another file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/link.html
     */
    public link(oldpath: string, newpath: string, callback: (err: Error | null) => void) {
        try {
            this.linkSync(oldpath, newpath);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Link one file to another file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/link.html
     */
    public linkSync(oldpath: string, newpath: string) {
        oldpath = this._resolve(oldpath);
        newpath = this._resolve(newpath);

        const { node, basename: oldBasename } = this._find(oldpath) || _throw(new IOError("ENOENT", "link", oldpath, newpath));
        if (isDirectoryInode(node)) throw new IOError("EPERM", "link", oldpath, newpath);

        const { node: newParent } = this._find(vpath.dirname(newpath)) || _throw(new IOError("ENOENT", "link", oldpath, newpath));
        if (!isDirectoryInode(newParent)) throw new IOError("ENOTDIR", "link", oldpath, newpath);

        const newParentLinks = this._getLinks(newParent);
        const newBasename = vpath.basename(newpath);

        if (newParentLinks.has(newBasename)) throw new IOError("EEXIST", "link", oldpath, newpath);
        if (!this._access(newParent, constants.W_OK)) throw new IOError("EACCES", "link", oldpath, newpath);
        if (this.isReadonly) throw new IOError("EROFS", "link", oldpath, newpath);

        const time = this.time();

        newParentLinks.set(newBasename, node);
        newParent.mtimeMs = time;

        node.nlink++;
        node.ctimeMs = time;

        this._notify(newParent, constants.IN_CREATE, newBasename);
        this._notify(node, constants.IN_ATTRIB, oldBasename);
    }

    /**
     * Remove a directory entry.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/unlink.html
     */
    public unlink(path: string, callback: (err: Error | null) => void) {
        try {
            this.unlinkSync(path);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Remove a directory entry.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/unlink.html
     */
    public unlinkSync(path: string) {
        path = this._resolve(path);

        const { parent, node, basename } = this._lfind(path) || _throw(new IOError("ENOENT", "unlink", path));
        if (isDirectoryInode(node)) throw new IOError("EISDIR", "unlink", path);
        if (!this._access(parent, constants.W_OK)) throw new IOError("EACCES", "unlink", path);
        if (this.isReadonly) throw new IOError("EROFS", "unlink", path);

        this._getLinks(parent).delete(basename);
        parent.mtimeMs = this.time();

        node.nlink--;
        node.ctimeMs = this.time();

        this._notify(parent, constants.IN_DELETE, basename);
        this._notify(node, constants.IN_ATTRIB);

        if (node.nlink === 0) {
            this._notify(node, constants.IN_DELETE_SELF);
            this._inotifyRemoveAllWatches(node);
        }
    }

    /**
     * Rename a file
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html
     */
    public rename(oldpath: string, newpath: string, callback: (err: Error | null) => void) {
        try {
            this.renameSync(oldpath, newpath);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Rename a file
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html
     */
    public renameSync(oldpath: string, newpath: string) {
        oldpath = this._resolve(oldpath);
        newpath = this._resolve(newpath);

        const { parent: oldParent, node: oldNode, basename: oldBasename } = this._lfind(oldpath) || _throw(new IOError("ENOENT", "rename", oldpath, newpath));
        const { node: newParent } = this._find(vpath.dirname(newpath)) || _throw(new IOError("ENOENT", "rename", oldpath, newpath));
        if (!isDirectoryInode(newParent)) throw new IOError("ENOTDIR", "rename", oldpath, newpath);

        const newBasename = vpath.basename(newpath);
        const newParentLinks = this._getLinks(newParent);
        const existingNode = newParentLinks.get(newBasename);
        if (existingNode) {
            if (isDirectoryInode(oldNode)) {
                if (!isDirectoryInode(existingNode)) throw new IOError("ENOTDIR", "rename", oldpath, newpath);
                if (this._getLinks(existingNode).size > 0) throw new IOError("ENOTEMPTY", "rename", oldpath, newpath);
            }
            else {
                if (isDirectoryInode(existingNode)) throw new IOError("EISDIR", "rename", oldpath, newpath);
            }
        }

        if (!this._access(oldParent, constants.W_OK)) throw new IOError("EACCES", "rename", oldpath, newpath);
        if (!this._access(newParent, constants.W_OK)) throw new IOError("EACCES", "rename", oldpath, newpath);
        if (this.isReadonly) throw new IOError("EROFS", "rename", oldpath, newpath);

        const time = this.time();
        if (existingNode) {
            existingNode.nlink--;
            existingNode.ctimeMs = time;
            if (existingNode.nlink === 0) {
                this._inotifyRemoveAllWatches(existingNode);
            }
        }

        this._getLinks(oldParent).delete(oldBasename);
        newParentLinks.set(newBasename, oldNode);
        oldParent.mtimeMs = time;
        newParent.mtimeMs = time;

        const cookie = ++cookieCount;
        this._notify(oldParent, constants.IN_MOVED_FROM, oldBasename, cookie);
        this._notify(newParent, constants.IN_MOVED_TO, newBasename, cookie);
        this._notify(oldNode, constants.IN_MOVE_SELF, oldBasename);
    }

    /**
     * Make a symbolic link
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/symlink.html
     */
    public symlink(target: string, linkpath: string, callback: (err: Error | null) => void) {
        try {
            this.symlinkSync(target, linkpath);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Make a symbolic link
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/symlink.html
     */
    public symlinkSync(target: string, linkpath: string) {
        target = vpath.validate(target, vpath.ValidationFlags.RelativeOrAbsolute);
        linkpath = this._resolve(linkpath);

        const dirname = vpath.dirname(linkpath);
        const { node: parent } = this._find(dirname) || _throw(new IOError("ENOENT", "symlink", target, linkpath));
        if (!isDirectoryInode(parent)) throw new IOError("ENOTDIR", "symlink", target, linkpath);

        const basename = vpath.basename(linkpath);
        const parentLinks = this._getLinks(parent);

        if (parentLinks.has(basename)) throw new IOError("EEXIST", "symlink", target, linkpath);
        if (!this._access(parent, constants.W_OK)) throw new IOError("EACCES", "symlink", target, linkpath);
        if (this.isReadonly) throw new IOError("EROFS", "symlink", target, linkpath);

        const time = this.time();

        const node = this._mknod(parent.dev, constants.S_IFLNK, 0o666);
        node.symlink = target;

        parentLinks.set(basename, node);
        parent.mtimeMs = time;

        this._notify(parent, constants.IN_CREATE | constants.IN_ISDIR, basename);
    }

    /**
     * Read the contents of a symbolic link
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readlink.html
     */
    public readlink(path: string, callback: (err: Error | null, path: string | null) => void) {
        try {
            process.nextTick(callback, null, this.readlinkSync(path));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Read the contents of a symbolic link
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/readlink.html
     */
    public readlinkSync(path: string) {
        path = this._resolve(path);

        const { node } = this._lfind(path) || _throw(new IOError("ENOENT", "readlink", path));
        if (!isSymlinkInode(node)) throw new IOError("EINVAL", "readlink", path);

        return node.symlink;
    }

    /**
     * Resolve a pathname
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/realpath.html
     */
    public realpath(path: string, callback: (err: Error | null, path: string | null) => void) {
        try {
            process.nextTick(callback, null, this.realpathSync(path));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Resolve a pathname
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/realpath.html
     */
    public realpathSync(path: string) {
        path = this._resolve(path);
        const entry = this._find(path) || _throw(new IOError("ENOENT", "realpath", path));
        return entry.path;
    }

    /**
     * Open a file
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/open.html
     */
    public open(path: string, flags: string | number, callback: (err: Error | null, fd: number | null) => void): void;
    /**
     * Open a file
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/open.html
     */
    public open(path: string, flags: string | number, mode: number, callback: (err: Error | null, fd: number | null) => void): void;
    public open(path: string, flags: string | number, mode: number | typeof callback, callback?: (err: Error | null, fd: number | null) => void) {
        if (typeof mode === "function") callback = mode, mode = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            process.nextTick(callback, null, this.openSync(path, flags, mode));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Open a file
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/open.html
     */
    public openSync(path: string, flags: string | number, mode = 0o666): number {
        path = this._resolve(path);
        flags = parseFlags(flags);
        if (!isFinite(flags) || !isFinite(mode)) throw new IOError("EINVAL", "open", path);

        const read = (flags & constants.O_ACCMODE) !== constants.O_WRONLY;
        const write = flags & constants.O_ACCMODE && flags & constants.O_CREAT | constants.O_TRUNC;
        if (write && this.isReadonly) throw new IOError("EROFS", "open", path);

        const basename = vpath.basename(path);
        const entry = this._walk(path, /*noFollow*/ !!(flags & constants.O_NOFOLLOW));

        let node: Inode;
        let parent: Inode;
        if (!entry) {
            if (~flags & constants.O_CREAT) throw new IOError("ENOENT", "open", path);
            if (flags & constants.O_DIRECTORY) throw new IOError("ENOTDIR", "open", path);

            const entry = this._walk(vpath.dirname(path), /*noFollow*/ false) || _throw(new IOError("ENOENT", "open", path));
            parent = entry.node;

            if (!isDirectoryInode(parent)) throw new IOError("ENOTDIR", "open", path);
            if (!this._access(parent, constants.W_OK)) throw new IOError("EACCES", "open", path);

            node = this._mknod(parent.dev, constants.S_IFREG, mode);
            node.buffer = Buffer.allocUnsafe(0);

            this._getLinks(parent).set(basename, node);
            parent.mtimeMs = this.time();

            if (parent.mode & constants.S_ISGID) {
                node.mode |= constants.S_ISGID;
                node.gid = parent.gid;
            }

            flags &= ~constants.O_TRUNC;

            this._notify(parent, constants.IN_CREATE, basename);
        }
        else {
            if (flags & constants.O_EXCL) throw new IOError("EEXIST", "open", path);
            node = entry.node;
            parent = entry.parent;
        }

        if (flags & constants.O_DIRECTORY && isFileInode(node)) throw new IOError("ENOTDIR", "open", path);
        if (write && isDirectoryInode(node)) throw new IOError("EISDIR", "open", path);
        if (write && !this._access(node, constants.W_OK)) throw new IOError("EACCES", "open", path);
        if (read && !this._access(node, constants.R_OK)) throw new IOError("EACCES", "open", path);

        const file: OpenFileDescription = {
            kind: "open",
            fd: ++fdCount,
            path,
            basename,
            parent,
            node,
            flags,
            written: false,
            offset: isFileInode(node) && (flags & (constants.O_APPEND | constants.O_TRUNC)) === constants.O_APPEND ? this._getSize(node) : 0,
            buffer: undefined
        };

        this._openFiles.set(file.fd, file);
        this._notify(parent, constants.IN_OPEN, basename);
        this._notify(node, constants.IN_OPEN, basename);

        if (flags & constants.O_TRUNC) {
            file.buffer = Buffer.allocUnsafe(0);
        }

        return file.fd;
    }

    /**
     * Close a file descriptor.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/close.html#
     */
    public close(fd: number, callback: (err: Error | null) => void) {
        try {
            this.closeSync(fd);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Close a file descriptor.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/close.html#
     */
    public closeSync(fd: number) {
        const entry = this._file("close", fd);
        this._openFiles.delete(entry.fd);
        if (isInotifyDescription(entry)) {
            for (const watch of entry.watches.values()) {
                if (watch.node.watches) {
                    watch.node.watches.delete(entry.fd);
                    if (watch.node.watches.size === 0) {
                        watch.node.watches = undefined;
                    }
                }
            }
            entry.watches.clear();
            entry.paths.clear();
        }
        else {
            this._fsync(entry, /*metadata*/ true);
            const mask = isWritable(entry) ? constants.IN_CLOSE_WRITE : constants.IN_CLOSE_NOWRITE;
            this._notify(entry.parent, mask, entry.basename);
            this._notify(entry.node, mask, entry.basename);
        }
    }

    /**
     * Read from a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/read.html
     */
    public read(fd: number, buffer: Buffer, offset: number, length: number, position: number | undefined, callback: (err: Error | null, bytesRead: number | null, buffer: Buffer) => void) {
        try {
            process.nextTick(callback, null, this.readSync(fd, buffer, offset, length, position), buffer);
        }
        catch (e) {
            process.nextTick(callback, e, null, buffer);
        }
    }

    /**
     * Read from a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/read.html
     */
    public readSync(fd: number, buffer: Buffer, offset: number, length: number, position?: number | null) {
        if (typeof position !== "number") position = -1;
        if (!isFinite(offset) || !isFinite(length) || !isFinite(position)) throw new IOError("EINVAL", "read");
        if (offset < 0 || length < 0 || position < -1 || offset > buffer.byteLength - length) throw new IOError("EINVAL", "read");
        if (length === 0) return 0;

        const entry = this._file("read", fd, "open", "file", constants.R_OK);
        const parent = entry.parent;
        const node = entry.node;
        if (position !== -1) entry.offset = position;
        if (!entry.buffer) entry.buffer = this._getBuffer(node);
        const bytesRead = entry.buffer.copy(buffer, offset, entry.offset, entry.offset + length);
        entry.offset += bytesRead;
        this._notify(parent, constants.IN_ACCESS, entry.basename);
        this._notify(node, constants.IN_ACCESS, entry.basename);
        return bytesRead;
    }

    /**
     * Read from a file.
     */
    public readFile(path: string | number, callback: (error: Error | null, data: string | Buffer | null) => void): void;
    /**
     * Read from a file.
     */
    public readFile(path: string | number, options: { encoding?: null, flag?: string | number } | null | undefined, callback: (error: Error | null, data: Buffer | null) => void): void;
    /**
     * Read from a file.
     */
    public readFile(path: string | number, options: { encoding: string, flag?: string | number } | string, callback: (error: Error | null, data: string | null) => void): void;
    /**
     * Read from a file.
     */
    public readFile(path: string | number, options: { encoding?: string | null, flag?: string | number } | string | null | undefined, callback: (error: Error | null, data: string | Buffer | null) => void): void;
    public readFile(path: string | number, options: { encoding?: string | null, flag?: string | number } | string | null | undefined | typeof callback, callback?: ((error: Error | null, data: string | null) => void) | ((error: Error | null, data: Buffer | null) => void)) {
        if (typeof options === "function") callback = options, options = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            process.nextTick(callback, null, this.readFileSync(path, options));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Read from a file.
     */
    public readFileSync(path: string | number, options?: { encoding?: null, flag?: string | number } | null): Buffer;
    /**
     * Read from a file.
     */
    public readFileSync(path: string | number, options: { encoding: string, flag?: string | number } | string): string;
    /**
     * Read from a file.
     */
    public readFileSync(path: string | number, options?: { encoding?: string | null, flag?: string | number } | string | null): string | Buffer;
    public readFileSync(path: string | number, options: { encoding?: string | null, flag?: string | number } | string | null = {}) {
        if (options === null || typeof options === "string") options = { encoding: options };
        const { encoding, flag = "r" } = options;
        const fd = typeof path === "number" ? path : this.openSync(path, flag, /*mode*/ 0o666);
        const size = this.fstatSync(fd).size;
        let buffer = Buffer.allocUnsafe(size);
        try {
            let offset = 0;
            let lastOffset: number | undefined;
            while (lastOffset !== offset && offset < size) {
                lastOffset = offset;
                offset += this.readSync(fd, buffer, offset, size - offset, offset);
            }
            if (offset < size) buffer = buffer.slice(0, offset);
        }
        finally {
            if (typeof path !== "number") {
                this.closeSync(fd);
            }
        }
        return encoding ? buffer.toString(encoding) : buffer;
    }

    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public write(fd: number, buffer: Buffer, callback: (error: Error | null, bytesWritten: number | null, buffer: Buffer) => void): void;
    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public write(fd: number, buffer: Buffer, offset: number | undefined, callback: (error: Error | null, bytesWritten: number | null, buffer: Buffer) => void): void;
    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public write(fd: number, buffer: Buffer, offset: number | undefined, length: number | undefined, callback: (error: Error | null, bytesWritten: number | null, buffer: Buffer) => void): void;
    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public write(fd: number, buffer: Buffer, offset: number | undefined, length: number | undefined, position: number | undefined, callback: (error: Error | null, bytesWritten: number | null, buffer: Buffer) => void): void;
    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public write(fd: number, string: string, callback: (error: Error | null, bytesWritten: number | null, string: string) => void): void;
    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public write(fd: number, string: string, position: number | null | undefined, callback: (error: Error | null, bytesWritten: number | null, string: string) => void): void;
    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public write(fd: number, string: string, position: number | null | undefined, encoding: string | undefined, callback: (error: Error | null, bytesWritten: number | null, string: string) => void): void;
    public write(fd: number, buffer: Buffer | string, offset?: number | null | typeof callback, length?: number | string | typeof callback, position?: number | typeof callback, callback?: ((error: Error | null, bytesWritten: number | null, buffer: Buffer) => void) | ((error: Error | null, bytesWritten: number | null, buffer: string) => void)) {
        if (typeof offset === "function") length = offset, offset = undefined;
        if (typeof length === "function") position = length, length = undefined;
        if (typeof position === "function") callback = position, position = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            if (Buffer.isBuffer(buffer)) {
                if (typeof offset !== "number") offset = undefined;
                if (typeof length !== "number") length = undefined;
                process.nextTick(callback, null, this.writeSync(fd, buffer, offset, length, position), buffer);
            }
            else {
                if (typeof length !== "string") length = undefined;
                process.nextTick(callback, null, this.writeSync(fd, buffer, offset, length));
            }
        }
        catch (e) {
            process.nextTick(callback, e, null, buffer);
        }
    }

    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public writeSync(fd: number, buffer: Buffer, offset?: number, length?: number, position?: number | null): number;
    /**
     * Write to a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/write.html
     */
    public writeSync(fd: number, string: string, position?: number | null, encoding?: string): number;
    public writeSync(fd: number, buffer: Buffer | string, offset?: number | null, length?: number | string, position?: number | null) {
        if (Buffer.isBuffer(buffer)) {
            if (typeof offset !== "number") offset = 0;
            if (typeof length !== "number") length = buffer.byteLength - offset;
        }
        else {
            buffer = Buffer.from(buffer, typeof length === "string" ? length : "utf8");
            position = offset;
            offset = 0;
            length = buffer.byteLength;
        }

        if (typeof position !== "number") position = -1;
        if (!isFinite(offset) || !isFinite(length) || !isFinite(position)) throw new IOError("EINVAL", "write");
        if (offset < 0 || length < 0 || position < -1 || offset > buffer.byteLength - length) throw new IOError("EINVAL", "write");
        if (length === 0) return;

        const entry = this._file("write", fd, "open", "file", constants.W_OK);
        const parent = entry.parent;
        const node = entry.node;
        if (position !== -1) entry.offset = position;
        if (!entry.buffer) {
            // if we haven't yet started writing, get a copy of the storage buffer
            const buffer = this._getBuffer(node);
            entry.buffer = Buffer.allocUnsafe(buffer.byteLength);
            buffer.copy(entry.buffer, 0, 0, buffer.byteLength);
        }
        if (entry.offset >= entry.buffer.byteLength - length) {
            // if we are writing to a point outside of the size of the buffer, resize it
            entry.buffer = resizeBuffer(entry.buffer, entry.offset + length);
        }
        const bytesWritten = buffer.copy(entry.buffer, entry.offset, offset, offset + length);
        entry.offset += bytesWritten;
        if (entry.flags & constants.O_SYNC) {
            this._fsync(entry, /*metadata*/ true);
        }
        return bytesWritten;
    }

    /**
     * Append to a file.
     */
    public appendFile(path: string | number, data: string | Buffer, callback: (error: Error | null) => void): void;
    /**
     * Append to a file.
     */
    public appendFile(path: string | number, data: string | Buffer, options: { encoding?: string | null, mode?: number, flag?: string | number } | string | null | undefined, callback: (error: Error | null) => void): void;
    public appendFile(path: string | number, data: string | Buffer, options: { encoding?: string | null, mode?: number, flag?: string | number } | string | null | typeof callback | undefined, callback?: (error: Error | null) => void) {
        if (typeof options === "function") callback = options, options = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            this.appendFileSync(path, data, options);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Append to a file.
     */
    public appendFileSync(path: string | number, data: string | Buffer, options: { encoding?: string | null, mode?: number, flag?: string | number } | string | null = {}) {
        if (options === null || typeof options === "string") options = { encoding: options };
        const { encoding, mode = 0o666, flag = "a" } = options;
        this.writeFileSync(path, data, { encoding, mode, flag });
    }

    /**
     * Write to a file.
     */
    public writeFile(path: string | number, data: string | Buffer, callback: (error: Error | null) => void): void;
    /**
     * Write to a file.
     */
    public writeFile(path: string | number, data: string | Buffer, options: { encoding?: string | null, mode?: number, flag?: string | number } | string | null | undefined, callback: (error: Error | null) => void): void;
    public writeFile(path: string | number, data: string | Buffer, options: { encoding?: string | null, mode?: number, flag?: string | number } | string | null | typeof callback | undefined, callback?: (error: Error | null) => void) {
        if (typeof options === "function") callback = options, options = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            this.writeFileSync(path, data, options);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Write to a file.
     */
    public writeFileSync(path: string | number, data: string | Buffer, options: { encoding?: string | null, mode?: number, flag?: string | number } | string | null = {}) {
        if (options === null || typeof options === "string") options = { encoding: options };
        const { encoding, mode = 0o666, flag = "w" } = options;
        const flags = parseFlags(flag);
        const fd = typeof path === "number" ? path : this.openSync(path, flags, mode);
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from("" + data, encoding || "utf8");
        try {
            let offset = 0;
            while (offset < buffer.byteLength) {
                offset += this.writeSync(fd, buffer, offset, buffer.byteLength - offset, flags & constants.O_APPEND ? null : offset);
            }
        }
        finally {
            if (typeof path !== "number") {
                this.closeSync(fd);
            }
        }
    }

    /**
     * Truncate a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/truncate.html
     */
    public truncate(path: string, callback: (error: Error | null) => void): void;
    /**
     * Truncate a file to a specified length.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/truncate.html
     */
    public truncate(path: string, length: number | undefined, callback: (error: Error | null) => void): void;
    public truncate(path: string, length: number | Function | undefined, callback?: Function) {
        if (typeof length === "function") callback = length, length = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            this.truncateSync(path, length);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Truncate a file to a specified length.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/truncate.html
     */
    public truncateSync(path: string, length: number = 0) {
        path = this._resolve(path);
        this._truncate("truncate", this._find(path) || _throw(new IOError("ENOENT", "truncate", path)), length);
    }

    /**
     * Truncate a file.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/ftruncate.html
     */
    public ftruncate(fd: number, callback: (error: Error | null) => void): void;
    /**
     * Truncate a file to a specified length.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/ftruncate.html
     */
    public ftruncate(fd: number, length: number | undefined, callback: (error: Error | null) => void): void;
    public ftruncate(fd: number, length: number | Function | undefined, callback?: Function) {
        if (typeof length === "function") callback = length, length = undefined;
        if (typeof callback !== "function") throw new IOError("EINVAL");
        try {
            this.ftruncateSync(fd, length);
            process.nextTick(callback, null);
        }
        catch (e) {
            process.nextTick(callback, e);
        }
    }

    /**
     * Truncate a file to a specified length.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/ftruncate.html
     */
    public ftruncateSync(fd: number, length: number = 0) {
        this._truncate("ftruncate", this._file("ftruncate", fd, "open", "file", constants.W_OK), length);
    }

    private _truncate(syscall: string, entry: FileDescription<Inode>, length: number, path?: string) {
        if (!isFinite(length)) throw new IOError("EINVAL", syscall, path);
        if (!isFileInode(entry.node)) throw new IOError("ENOENT", syscall, path);
        if (this.isReadonly) throw new IOError("EROFS", syscall, path);

        if (this._getSize(entry.node) !== length) {
            this._resize(entry.node, entry.node, length);
        }

        entry.node.mtimeMs = this.time();
        this._notify(entry.parent, constants.IN_MODIFY, entry.basename);
        this._notify(entry.node, constants.IN_MODIFY, entry.basename);
    }

    /**
     * Makes a temporary directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkdtemp.html
     */
    public mkdtemp(template: string, callback: (error: Error | null, folder: string | null) => void) {
        try {
            process.nextTick(callback, null, this.mkdtempSync(template));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Makes a temporary directory.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkdtemp.html
     */
    public mkdtempSync(template: string) {
        this.mkdirSync(this._mktemp("mkdtemp", template));
    }

    /**
     * Makes a temporary file, returning a file descriptor.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkstemp.html
     */
    public mkstemp(template: string, callback: (error: Error | null, fd: number | null) => void) {
        try {
            process.nextTick(callback, null, this.mkstempSync(template));
        }
        catch (e) {
            process.nextTick(callback, e, null);
        }
    }

    /**
     * Makes a temporary file, returning a file descriptor.
     *
     * @link http://pubs.opengroup.org/onlinepubs/9699919799/functions/mkstemp.html
     */
    public mkstempSync(template: string) {
        return this.openSync(this._mktemp("mkstemp", template), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, constants.S_IRUSR | constants.S_IWUSR);
    }

    private _mktemp(syscall: string, template: string) {
        if (this.isReadonly) throw new IOError("EROFS", syscall, template);

        template = this._resolve(template);
        if (vpath.hasTrailingSeparator(template)) throw new IOError("EINVAL", syscall, template);

        const basename = vpath.basename(template);
        let count = 0;
        for (let i = basename.length - 1; i >= 0; i--) {
            if (basename.charAt(i) !== "X") break;
            count++;
        }
        if (count < 6) throw new IOError("EINVAL", syscall, template);

        const { node: parent, path } = this._find(vpath.dirname(template)) || _throw(new IOError("ENOENT", syscall, template));
        if (!isDirectoryInode(parent)) throw new IOError("ENOTDIR", syscall, template);
        if (!this._access(parent, constants.W_OK)) throw new IOError("EACCES", syscall, template);

        const parentLinks = this._getLinks(parent);
        const prefix = basename.slice(0, basename.length - count);
        while (true) {
            let suffix = "";
            while (suffix.length < count) {
                suffix += FileSystem._portableFilenameCharSet.charAt(Math.floor(Math.random() * FileSystem._portableFilenameCharSet.length));
            }
            const name = prefix + suffix;
            if (!parentLinks.has(name)) return vpath.combine(path, name);
        }
    }

    /**
     * Watch a path for changes.
     */
    public watch(path: string, callback?: (eventType: string, filename: string) => void) {
        const watcher = new FSWatcher(this);
        if (callback) watcher.on("change", callback);
        watcher.start(path);
        return watcher;
    }

    /**
     * Watch a path for changes using polling.
     */
    public watchFile(path: string, callback: (current: Stats, previous: Stats) => void): void;
    /**
     * Watch a path for changes using polling.
     */
    public watchFile(path: string, options: { interval?: number } | undefined, callback: (current: Stats, previous: Stats) => void): void;
    public watchFile(path: string, options: { interval?: number } | typeof callback | undefined, callback?: (current: Stats, previous: Stats) => void) {
        if (typeof options === "function") callback = options, options = undefined;
        if (!options) options = { };
        if (typeof callback !== "function") throw new IOError("EINVAL");
        path = this._resolve(path);
        const entry = this._find(path);
        const { interval = 5007 } = options;
        const watchedFiles = this._lazy.watchedFiles || (this._lazy.watchedFiles = new core.SortedMap(this.stringComparer));
        let watchedFileSet = watchedFiles.get(path);
        if (!watchedFileSet) watchedFiles.set(path, watchedFileSet = new Set());
        const watchedFile: WatchedFile = {
            path,
            handle: this._timers.setInterval(() => this._onWatchInterval(watchedFile), interval),
            previous: entry ? this._stat("stat", entry, path) : new Stats(),
            listener: callback
        };
        watchedFileSet.add(watchedFile);
        if (!entry) {
            callback(watchedFile.previous, watchedFile.previous);
        }
    }

    private _onWatchInterval(watchedFile: WatchedFile) {
        if (watchedFile.handle === undefined) return;
        const entry = this._find(watchedFile.path);
        const previous = watchedFile.previous;
        const current = entry ? this._stat("stat", entry, watchedFile.path) : new Stats();
        if (current.dev !== previous.dev ||
            current.ino !== previous.ino ||
            current.mode !== previous.mode ||
            current.nlink !== previous.nlink ||
            current.uid !== previous.uid ||
            current.gid !== previous.gid ||
            current.rdev !== previous.rdev ||
            current.size !== previous.size ||
            current.blksize !== previous.blksize ||
            current.blocks !== previous.blocks ||
            current.atimeMs !== previous.atimeMs ||
            current.mtimeMs !== previous.mtimeMs ||
            current.ctimeMs !== previous.ctimeMs ||
            current.birthtimeMs !== previous.birthtimeMs) {
            watchedFile.previous = current;
            const callback = watchedFile.listener;
            callback(current, previous);
        }
    }

    /**
     * Stop watching a path for changes.
     */
    public unwatchFile(path: string, callback?: (current: Stats, previous: Stats) => void) {
        path = this._resolve(path);

        const watchedFiles = this._lazy.watchedFiles;
        if (!watchedFiles) return;

        const watchedFileSet = watchedFiles.get(path);
        if (!watchedFileSet) return;

        for (const watchedFile of watchedFileSet) {
            if (!callback || watchedFile.listener === callback) {
                this._timers.clearInterval(watchedFile.handle);
                watchedFileSet.delete(watchedFile);
                watchedFile.handle = undefined;
            }
        }

        if (watchedFileSet.size === 0) {
            watchedFiles.delete(path);
        }
    }

    /**
     * Initialize an inotify instance.
     *
     * @link http://man7.org/linux/man-pages/man2/inotify_init.2.html
     */
    private _inotify_init(callback: (event: WatchEvent) => void) {
        const file: InotifyDescription = {
            kind: "inotify",
            fd: ++fdCount,
            watches: new Map<number, WatchDescription>(),
            paths: new core.SortedMap<string, WatchDescription>(this.stringComparer),
            callback
        };

        this._openFiles.set(file.fd, file);
        return file.fd;
    }

    /**
     * Add a watched path to an inotify instance.
     *
     * @link http://man7.org/linux/man-pages/man2/inotify_add_watch.2.html
     */
    private _inotify_add_watch(fd: number, path: string, mask: number) {path = this._resolve(path);
        const watcher = this._file("inotify_add_watch", fd, "inotify");

        path = this._resolve(path);
        if (!isFinite(mask)) throw new IOError("EINVAL", "inotify_add_watch", path);

        const noFollow = !!(mask & constants.IN_DONT_FOLLOW);
        const { node } = this._walk(path, noFollow) || _throw(new IOError("ENOENT", "inotify_add_watch", path));

        if (mask & constants.IN_ONLYDIR && !isDirectoryInode(node)) throw new IOError("ENOTDIR", "inotify_add_watch", path);
        if (!node.watches) node.watches = new Map<number, WatchDescription>();

        let watch = node.watches.get(fd);
        if (watch) {
            watch.mask = (mask & constants.IN_MASK_ADD ? watch.mask : 0) | (mask & IN_MASK);
        }
        else {
            watch = { wd: ++wdCount, watcher, path, node, mask: mask & IN_MASK };
            watcher.watches.set(watch.wd, watch);
            watcher.paths.set(path, watch);
            node.watches.set(fd, watch);
        }

        return watch.wd;
    }

    /**
     * Remove an existing watch from an inotify instance.
     *
     * @link http://man7.org/linux/man-pages/man2/inotify_rm_watch.2.html
     */
    private _inotify_rm_watch(fd: number, wd: number) {
        const watcher = this._openFiles.get(fd);
        if (!watcher || !isInotifyDescription(watcher)) throw new IOError("EBADF", "inotify_rm_watch");

        const watch = watcher.watches.get(wd);
        if (!watch) throw new IOError("EBADF", "inotify_rm_watch");

        this._inotifyRemoveOneWatch(watch, /*notifyIgnored*/ true);
    }

    public debugPrint(): void {
        let result = "";
        const printLinks = (dirname: string | undefined, links: core.SortedMap<string, Inode>) => {
            for (const [name, node] of links) {
                const path = dirname ? vpath.combine(dirname, name) : name;
                const marker = vpath.compare(this._cwd, path, this.ignoreCase) === 0 ? "*" : " ";
                if (result) result += "\n";
                result += marker;
                if (isDirectoryInode(node)) {
                    result += vpath.addTrailingSeparator(path);
                    printLinks(path, this._getLinks(node));
                }
                else if (isFileInode(node)) {
                    result += path;
                }
                else if (isSymlinkInode(node)) {
                    result += path + " -> " + node.symlink;
                }
            }
        }
        printLinks(/*dirname*/ undefined, this._getRootLinks());
        console.log(result);
    }

    private _mknod(dev: number, type: typeof constants.S_IFREG, mode: number, uid?: number, gid?: number, umask?: number): FileInode;
    private _mknod(dev: number, type: typeof constants.S_IFDIR, mode: number, uid?: number, gid?: number, umask?: number): DirectoryInode;
    private _mknod(dev: number, type: typeof constants.S_IFLNK, mode: number, uid?: number, gid?: number, umask?: number): SymlinkInode;
    private _mknod(dev: number, type: number, mode: number, uid = this.getuid(), gid = this.getgid(), umask = this.umask()) {
        const timestamp = this.time();
        return <Inode>{
            dev,
            ino: ++inoCount,
            mode: (mode & ~constants.S_IFMT & ~umask & 0o7777) | (type & constants.S_IFMT),
            uid,
            gid,
            atimeMs: timestamp,
            mtimeMs: timestamp,
            ctimeMs: timestamp,
            birthtimeMs: timestamp,
            nlink: 1
        };
    }

    private _getRootLinks() {
        if (!this._lazy.links) {
            this._lazy.links = new core.SortedMap<string, Inode>(this.stringComparer);
            if (this._shadowRoot) {
                this._copyShadowLinks(this._shadowRoot._getRootLinks(), this._lazy.links);
            }
            this._lazy.links = this._lazy.links;
        }
        return this._lazy.links;
    }

    private _getLinks(node: DirectoryInode) {
        if (!node.links) {
            const links = new core.SortedMap<string, Inode>(this.stringComparer);
            const { source, resolver } = node;
            if (source && resolver) {
                node.source = undefined;
                node.resolver = undefined;
                for (const name of resolver.readdirSync(source)) {
                    const path = vpath.combine(source, name);
                    const stats = resolver.statSync(path);
                    switch (stats.mode & constants.S_IFMT) {
                        case constants.S_IFDIR:
                            const vdir = this._mknod(node.dev, constants.S_IFDIR, 0o777);
                            vdir.source = vpath.combine(source, name);
                            vdir.resolver = resolver;
                            links.set(name, vdir);
                            break;
                        case constants.S_IFREG:
                            const vfile = this._mknod(node.dev, constants.S_IFREG, 0o666);
                            vfile.source = vpath.combine(source, name);
                            vfile.resolver = resolver;
                            vfile.size = stats.size;
                            links.set(name, vfile);
                            break;
                    }
                }
            }
            else if (this._shadowRoot && node.shadowRoot) {
                this._copyShadowLinks(this._shadowRoot._getLinks(node.shadowRoot), links);
            }
            node.links = links;
        }
        return node.links;
    }

    private _copyShadowLinks(source: ReadonlyMap<string, Inode>, target: core.SortedMap<string, Inode>) {
        for (const [name, root] of source) {
            const shadow = <Inode>{
                dev: root.dev,
                ino: root.ino,
                mode: root.mode,
                uid: root.uid,
                gid: root.gid,
                atimeMs: root.atimeMs,
                mtimeMs: root.mtimeMs,
                ctimeMs: root.ctimeMs,
                birthtimeMs: root.birthtimeMs,
                nlink: root.nlink,
                shadowRoot: root
            };
            if (isSymlinkInode(root)) {
                (<SymlinkInode>shadow).symlink = root.symlink;
            }
            target.set(name, shadow);
        }
    }

    private _getSize(node: FileInode): number {
        if (node.buffer) return node.buffer.byteLength;
        if (node.size !== undefined) return node.size;
        if (node.source && node.resolver) return node.size = node.resolver.statSync(node.source).size;
        if (this._shadowRoot && node.shadowRoot) return node.size = this._shadowRoot._getSize(node.shadowRoot);
        return 0;
    }

    private _getBuffer(node: FileInode): Buffer {
        if (!node.buffer) {
            const { source, resolver } = node;
            if (source && resolver) {
                node.source = undefined;
                node.resolver = undefined;
                node.size = undefined;
                node.buffer = resolver.readFileSync(source);
            }
            else if (this._shadowRoot && node.shadowRoot) {
                node.buffer = this._shadowRoot._getBuffer(node.shadowRoot);
            }
            else {
                node.buffer = Buffer.allocUnsafe(0);
            }
        }
        return node.buffer;
    }

    private _file(syscall: string, fd: number): OpenFileDescription | InotifyDescription;
    private _file(syscall: string, fd: number, source: "open"): OpenFileDescription;
    private _file(syscall: string, fd: number, source: "open", kind: "directory"): OpenFileDescription<DirectoryInode>;
    private _file(syscall: string, fd: number, source: "open", kind: "file", mode?: number): OpenFileDescription<FileInode>;
    private _file(syscall: string, fd: number, source: "inotify"): InotifyDescription;
    private _file(syscall: string, fd: number, source?: "open" | "inotify", kind?: "file" | "directory", mode: number = constants.F_OK) {
        const entry = this._openFiles.get(fd);
        if (!entry) throw new IOError("EBADF", syscall);
        if (source === "open" && !isOpenFileDescription(entry)) throw new IOError("EBADF", syscall);
        if (source === "inotify" && !isInotifyDescription(entry)) throw new IOError("EBADF", syscall);
        if (isOpenFileDescription(entry)) {
            if (kind === "file" && isDirectoryInode(entry.node)) throw new IOError("EISDIR", syscall);
            if (kind === "file" && !isFileInode(entry.node)) throw new IOError("EBADF", syscall);
            if (kind === "directory" && !isDirectoryInode(entry.node)) throw new IOError("EBADF", syscall);
            if (mode & constants.W_OK && !isWritable(entry)) throw new IOError("EBADF", syscall);
            if (mode & constants.R_OK && !isReadable(entry)) throw new IOError("EBADF", syscall);
        }
        return entry;
    }

    private _find(path: string): FileDescription | undefined {
        return this._walk(path, /*noFollow*/ false);
    }

    private _lfind(path: string): FileDescription | undefined {
        return this._walk(path, /*noFollow*/ true);
    }

    // http://man7.org/linux/man-pages/man7/path_resolution.7.html
    private _walk(path: string, noFollow: boolean): FileDescription | undefined {
        let links: core.SortedMap<string, Inode> = this._getRootLinks();
        let parent: DirectoryInode | undefined;
        let components = vpath.parse(path);
        let step = 0;
        let depth = 0;
        while (step < components.length) {
            if (depth >= 40) throw new IOError("ELOOP", "scandir", vpath.format(components.slice(0, step)));

            const lastStep = step === components.length - 1;
            const basename = components[step];
            const node = links.get(basename);
            if (node === undefined) return undefined;

            if (isSymlinkInode(node) && !(noFollow && lastStep)) {
                const dirname = vpath.format(components.slice(0, step));
                const symlink = vpath.resolve(dirname, node.symlink);
                if (!vpath.isAbsolute(symlink)) throw new Error("Path not absolute");

                links = this._getRootLinks();
                parent = undefined;
                components = vpath.parse(symlink).concat(components.slice(step + 1));
                step = 0;
                depth++;
                continue;
            }

            if (lastStep) {
                const path = vpath.format(components);
                if (!parent && isDirectoryInode(node)) parent = node;
                if (!parent) throw new IOError("ENOENT", "scandir", path);
                return { path, basename, parent, node };
            }

            if (isDirectoryInode(node)) {
                const subpath = vpath.format(components.slice(0, step + 1));
                if (!this._access(node, constants.X_OK)) throw new IOError("EACCES", "scandir", path);
                links = this._getLinks(node);
                parent = node;
                step++;
                continue;
            }

            throw new IOError("ENOTDIR", "scandir", vpath.format(components.slice(0, step + 1)));
        }

        return undefined;
    }

    private _resize(node: FileInode, entry: { buffer: Buffer | undefined }, size: number) {
        if (!entry.buffer) {
            entry.buffer = this._getBuffer(node);
        }
        const oldSize = entry.buffer.byteLength;
        if (entry.buffer.byteLength !== size) {
            const oldBuffer = entry.buffer;
            entry.buffer = size < oldSize ? Buffer.allocUnsafe(size) : Buffer.alloc(size);
            oldBuffer.copy(entry.buffer, 0, 0, Math.min(oldSize, size));
        }
    }

    private _inotifyRemoveOneWatch(watch: WatchDescription, notifyIgnored: boolean) {
        const watcher = watch.watcher;
        if (watch.node.watches) {
            watch.node.watches.delete(watcher.fd);
            if (watch.node.watches.size === 0) {
                watch.node.watches = undefined;
            }
        }

        watcher.watches.delete(watch.wd);
        watcher.paths.delete(watch.path);

        if (notifyIgnored) {
            this._inotifyNotifyOneWatch(watch, constants.IN_IGNORED, /*name*/ undefined, /*cookie*/ 0);
        }
    }

    private _inotifyRemoveAllWatches(node: Inode) {
        if (node.watches) {
            const watches = [...node.watches.values()];
            node.watches = undefined;

            for (const { wd, path, watcher } of watches) {
                watcher.watches.delete(wd);
                watcher.paths.delete(path);
            }

            this._inotifyNotifyAllWatches(watches, constants.IN_IGNORED, /*name*/ undefined, /*cookie*/ 0);
        }
    }

    private _inotifyNotifyAllWatches(watches: Iterable<WatchDescription>, mask: number, name: string | undefined, cookie: number) {
        for (const watch of watches) {
            this._inotifyNotifyOneWatch(watch, mask, name, cookie);
        }
    }

    private _inotifyNotifyOneWatch(watch: WatchDescription, mask: number, name: string = vpath.basename(watch.path), cookie: number) {
        if (mask = (mask & watch.mask) | (mask & ~constants.IN_ALL_EVENTS)) {
            const callback = watch.watcher.callback;
            callback({ wd: watch.wd, mask, name, cookie });
            if (watch.mask & constants.IN_ONESHOT) {
                this._inotifyRemoveOneWatch(watch, /*notifyIgnored*/ false);
            }
        }
    }

    private _notify(node: Inode, mask: number, name?: string, cookie: number = 0) {
        if (node.watches) {
            this._inotifyNotifyAllWatches(node.watches.values(), mask, name, cookie);
        }
    }

    private _resolve(path: string) {
        return this._cwd
            ? vpath.resolve(this._cwd, vpath.validate(path, vpath.ValidationFlags.RelativeOrAbsolute))
            : vpath.validate(path, vpath.ValidationFlags.Absolute);
    }

    private _applyFiles(files: FileMap, dirname: string) {
        const deferred: [Symlink | Link | Mount, string][] = [];
        this._applyFilesWorker(files, dirname, deferred);
        for (const [entry, path] of deferred) {
            this.mkdirpSync(vpath.dirname(path), 0o777);
            this.pushd(vpath.dirname(path));
            if (entry instanceof Symlink) {
                if (this.stringComparer(vpath.dirname(path), path) === 0) {
                    throw new TypeError("Roots cannot be symbolic links.");
                }
                this.symlinkSync(entry.symlink, path);
                this._applyFileExtendedOptions(path, entry);
            }
            else if (entry instanceof Link) {
                if (this.stringComparer(vpath.dirname(path), path) === 0) {
                    throw new TypeError("Roots cannot be hard links.");
                }
                this.linkSync(entry.path, path);
            }
            else {
                this.mountSync(entry.source, path, entry.resolver);
                this._applyFileExtendedOptions(path, entry);
            }
            this.popd();
        }
    }

    private _applyFileExtendedOptions(path: string, entry: Directory | File | Symlink | Mount) {
        const { uid = -1, gid = -1, mode, meta } = entry;
        if (uid !== -1 || gid !== -1) this.chownSync(path, uid, gid);
        if (mode !== undefined) this.chmodSync(path, mode);
        if (meta !== undefined) {
            const filemeta = this.filemeta(path);
            for (const key of Object.keys(meta)) {
                filemeta.set(key, meta[key]);
            }
        }
    }

    private _applyFilesWorker(files: FileMap, dirname: string, deferred: [Symlink | Link | Mount, string][]) {
        for (const key of Object.keys(files)) {
            const value = this._normalizeFileMapEntry(files[key]);
            const path = dirname ? vpath.resolve(dirname, key) : key;
            vpath.validate(path, vpath.ValidationFlags.Absolute);
            if (value === null || value === undefined) {
                if (this.stringComparer(vpath.dirname(path), path) === 0) {
                    throw new TypeError("Roots cannot be deleted.");
                }
                this.rimrafSync(path);
            }
            else if (value instanceof File) {
                if (this.stringComparer(vpath.dirname(path), path) === 0) {
                    throw new TypeError("Roots cannot be files.");
                }
                this.mkdirpSync(vpath.dirname(path), 0o777);
                this.writeFileSync(path, value.data, value.encoding);
                this._applyFileExtendedOptions(path, value);
            }
            else if (value instanceof Directory) {
                this.mkdirpSync(path, 0o777);
                this._applyFileExtendedOptions(path, value);
                this._applyFilesWorker(value.files, path, deferred);
            }
            else {
                deferred.push([value, path]);
            }
        }
    }

    private _normalizeFileMapEntry(value: FileMap[string]) {
        if (value === undefined ||
            value === null ||
            value instanceof Directory ||
            value instanceof File ||
            value instanceof Link ||
            value instanceof Symlink ||
            value instanceof Mount) {
            return value;
        }
        return typeof value === "string" || Buffer.isBuffer(value) ? new File(value) : new Directory(value);
    }
}

export interface FileSystemOptions {
    uid?: number;
    gid?: number;
    umask?: number;
    time?: number | Date | (() => number | Date);
    files?: FileMap;
    timers?: FileSystemTimers;
    cwd?: string;
    meta?: Record<string, any>;
}

export type Axis = "ancestors" | "ancestors-or-self" | "self" | "descendants-or-self" | "descendants";

export interface Traversal {
    traverse?(path: string, stats: Stats): boolean;
    accept?(path: string, stats: Stats): boolean;
}

export class Stats {
    public dev: number;
    public ino: number;
    public mode: number;
    public nlink: number;
    public uid: number;
    public gid: number;
    public rdev: number;
    public size: number;
    public blksize: number;
    public blocks: number;
    public atimeMs: number;
    public mtimeMs: number;
    public ctimeMs: number;
    public birthtimeMs: number;
    public atime: Date;
    public mtime: Date;
    public ctime: Date;
    public birthtime: Date;

    constructor();
    constructor(dev: number, ino: number, mode: number, nlink: number, uid: number, gid: number, rdev: number, size: number, blksize: number, blocks: number, atimeMs: number, mtimeMs: number, ctimeMs: number, birthtimeMs: number);
    constructor(dev: number = 0, ino: number = 0, mode: number = 0, nlink: number = 0, uid: number = 0, gid: number = 0, rdev: number = 0, size: number = 0, blksize: number = 0, blocks: number = 0, atimeMs: number = 0, mtimeMs: number = 0, ctimeMs: number = 0, birthtimeMs: number = 0) {
        this.dev = dev;
        this.ino = ino;
        this.mode = mode;
        this.nlink = nlink;
        this.uid = uid;
        this.gid = gid;
        this.rdev = rdev;
        this.size = size;
        this.blksize = blksize;
        this.blocks = blocks;
        this.atimeMs = atimeMs;
        this.mtimeMs = mtimeMs;
        this.ctimeMs = ctimeMs;
        this.birthtimeMs = birthtimeMs;
        this.atime = new Date(this.atimeMs);
        this.mtime = new Date(this.mtimeMs);
        this.ctime = new Date(this.ctimeMs);
        this.birthtime = new Date(this.birthtimeMs);
    }

    public isFile() { return (this.mode & constants.S_IFMT) === constants.S_IFREG; }
    public isDirectory() { return (this.mode & constants.S_IFMT) === constants.S_IFDIR; }
    public isSymbolicLink() { return (this.mode & constants.S_IFMT) === constants.S_IFLNK; }
    public isBlockDevice() { return (this.mode & constants.S_IFMT) === constants.S_IFBLK; }
    public isCharacterDevice() { return (this.mode & constants.S_IFMT) === constants.S_IFCHR; }
    public isFIFO() { return (this.mode & constants.S_IFMT) === constants.S_IFIFO; }
    public isSocket() { return (this.mode & constants.S_IFMT) === constants.S_IFSOCK; }
}

export class FSWatcher extends events.EventEmitter {
    private _fs: FileSystem;
    private _fd: number;
    private _wd: number = -1;
    private _onNotify = (event: WatchEvent) => { this._notify(event); };

    constructor(fs: FileSystem) {
        super();
        this._fs = fs;
        this._fd = this._fs["_inotify_init"](this._onNotify);
    }

    public start(path: string) {
        if (this._fd === -1) return; // already closed
        if (this._wd !== -1) return; // already started

        const mask =
            constants.IN_CREATE | // file creation
            constants.IN_MODIFY | // file closed
            constants.IN_DELETE | constants.IN_DELETE_SELF | // file deletion
            constants.IN_MOVED_FROM | constants.IN_MOVED_TO | constants.IN_MOVE_SELF; // file rename

        this._wd = this._fs["_inotify_add_watch"](this._fd, path, mask);
    }

    public close(): void {
        if (this._fd === -1) return; // already closed
        if (this._wd !== -1) this._fs["_inotify_rm_watch"](this._fd, this._wd);
        this._fs.closeSync(this._fd);
        this._fd = -1;
        this._wd = -1;
    }

    private _notify(event: WatchEvent) {
        if ((event.mask & constants.IN_IGNORED) === constants.IN_IGNORED) return;
        this.emit("change", (event.mask & constants.IN_ALL_EVENTS) & ~constants.IN_MODIFY ? "rename" : "change", event.name);
    }
}

// #region FSWatcher Event "change"
export interface FSWatcher {
    on(event: "change", listener: (eventType: string, filename: string) => void): this;
    once(event: "change", listener: (eventType: string, filename: string) => void): this;
    addListener(event: "change", listener: (eventType: string, filename: string) => void): this;
    removeListener(event: "change", listener: (eventType: string, filename: string) => void): this;
    prependListener(event: "change", listener: (eventType: string, filename: string) => void): this;
    prependOnceListener(event: "change", listener: (eventType: string, filename: string) => void): this;
    emit(name: "change", eventType: string, filename: string): boolean;
}
// #endregion FSWatcher Event "change"

// #region FSWatcher Event "error"
export interface FSWatcher {
    on(event: "error", listener: (error: Error) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    addListener(event: "error", listener: (error: Error) => void): this;
    removeListener(event: "error", listener: (error: Error) => void): this;
    prependListener(event: "error", listener: (error: Error) => void): this;
    prependOnceListener(event: "error", listener: (error: Error) => void): this;
    emit(name: "error", error: Error): boolean;
}
// #endregion FSWatcher Event "error"

/* @internal */
export interface WatchEvent {
    readonly wd: number;
    readonly mask: number;
    readonly cookie: number;
    readonly name: string;
}

export interface FileSystemResolver {
    statSync(path: string): { mode: number; size: number; };
    readdirSync(path: string): string[];
    readFileSync(path: string): Buffer;
}

export interface FileSystemTimers {
    setInterval(callback: (...args: any[]) => void, ms: number, ...args: any[]): any;
    clearInterval(handle: any): void;
}

export interface FileMap {
    [name: string]: DirectoryLike | FileLike | Link | Symlink | Mount | null | undefined;
}

export type DirectoryLike = FileMap | Directory;
export type FileLike = File | Buffer | string;

/** Extended options for a directory in a `FileMap` */
export class Directory {
    public readonly files: FileMap;
    public readonly uid: number | undefined;
    public readonly gid: number | undefined;
    public readonly mode: number | undefined;
    public readonly meta: Record<string, any>;
    constructor(files: FileMap, { uid, gid, mode, meta }: { uid?: number, gid?: number, mode?: number, meta?: Record<string, any> } = {}) {
        this.files = files;
        this.uid = uid;
        this.gid = gid;
        this.mode = mode;
        this.meta = meta;
    }
}

/** Extended options for a file in a `FileMap` */
export class File {
    public readonly data: Buffer | string;
    public readonly encoding: string | undefined;
    public readonly uid: number | undefined;
    public readonly gid: number | undefined;
    public readonly mode: number | undefined;
    public readonly meta: Record<string, any>;
    constructor(data: Buffer | string, { uid, gid, mode, meta, encoding }: { encoding?: string, uid?: number, gid?: number, mode?: number, meta?: Record<string, any> } = {}) {
        this.data = data;
        this.encoding = encoding;
        this.uid = uid;
        this.gid = gid;
        this.mode = mode;
        this.meta = meta;
    }
}

/** Extended options for a hard link in a `FileMap` */
export class Link {
    public readonly path: string;
    constructor(path: string) {
        this.path = path;
    }
}

/** Extended options for a symbolic link in a `FileMap` */
export class Symlink {
    public readonly symlink: string;
    public readonly uid: number | undefined;
    public readonly gid: number | undefined;
    public readonly mode: number | undefined;
    public readonly meta: Record<string, any>;
    constructor(symlink: string, { uid, gid, mode, meta }: { uid?: number, gid?: number, mode?: number, meta?: Record<string, any> } = {}) {
        this.symlink = symlink;
        this.uid = uid;
        this.gid = gid;
        this.mode = mode;
        this.meta = meta;
    }
}

/** Extended options for mounting a virtual copy of an external file system via a `FileMap` */
export class Mount {
    public readonly source: string;
    public readonly resolver: FileSystemResolver;
    public readonly uid: number | undefined;
    public readonly gid: number | undefined;
    public readonly mode: number | undefined;
    public readonly meta: Record<string, any>;
    constructor(source: string, resolver: FileSystemResolver, { uid, gid, mode, meta }: { uid?: number, gid?: number, mode?: number, meta?: Record<string, any> } = {}) {
        this.source = source;
        this.resolver = resolver;
        this.uid = uid;
        this.gid = gid;
        this.mode = mode;
        this.meta = meta;
    }
}

// a generic POSIX inode
type Inode = FileInode | DirectoryInode | SymlinkInode;

interface FileInode {
    // inode
    dev: number; // device id
    ino: number; // inode id
    mode: number; // file mode
    uid: number; // owner user id
    gid: number; // owner group id
    atimeMs: number; // access time
    mtimeMs: number; // modified time
    ctimeMs: number; // status change time
    birthtimeMs: number; // creation time
    nlink: number; // number of hard links

    // file inode
    size: number | undefined;
    buffer: Buffer;
    source: string | undefined;
    resolver: FileSystemResolver | undefined;
    shadowRoot: FileInode | undefined;

    // extra
    meta?: core.Metadata; // metadata stored on the inode
    watches?: Map<number, WatchDescription>; // maps inotify fd to watch description
}

interface DirectoryInode {
    // inode
    dev: number; // device id
    ino: number; // inode id
    mode: number; // file mode
    uid: number; // owner user id
    gid: number; // owner group id
    atimeMs: number; // access time
    mtimeMs: number; // modified time
    ctimeMs: number; // status change time
    birthtimeMs: number; // creation time
    nlink: number; // number of hard links

    // directory inode
    links: core.SortedMap<string, Inode> | undefined;
    source: string | undefined;
    resolver: FileSystemResolver | undefined;
    shadowRoot: DirectoryInode | undefined;

    // extra
    meta?: core.Metadata; // metadata stored on the inode
    watches?: Map<number, WatchDescription>; // maps inotify fd to watch description
}

interface SymlinkInode {
    // inode
    dev: number; // device id
    ino: number; // inode id
    mode: number; // file mode
    uid: number; // owner user id
    gid: number; // owner group id
    atimeMs: number; // access time
    mtimeMs: number; // modified time
    ctimeMs: number; // status change time
    birthtimeMs: number; // creation time
    nlink: number; // number of hard links

    // symlink inode
    symlink: string;
    shadowRoot: SymlinkInode | undefined;

    // extra
    meta?: core.Metadata; // metadata stored on the inode
    watches?: Map<number, WatchDescription>; // maps inotify fd to watch description
}

function isFileInode(node: Inode): node is FileInode {
    return (node.mode & constants.S_IFMT) === constants.S_IFREG;
}

function isDirectoryInode(node: Inode): node is DirectoryInode {
    return (node.mode & constants.S_IFMT) === constants.S_IFDIR;
}

function isSymlinkInode(node: Inode): node is SymlinkInode {
    return (node.mode & constants.S_IFMT) === constants.S_IFLNK;
}

interface FileDescription<TInode extends Inode = Inode> {
    path: string;
    basename: string;
    parent: DirectoryInode;
    node: TInode;
}

interface OpenFileDescription<TInode extends Inode = Inode> extends FileDescription<TInode> {
    kind: "open";
    fd: number;
    flags: number;
    offset: number;
    written: boolean;
    buffer: Buffer | undefined;
}

interface InotifyDescription {
    kind: "inotify";
    fd: number;
    watches: Map<number, WatchDescription>;
    paths: core.SortedMap<string, WatchDescription>;
    callback: (event: WatchEvent) => void;
}

interface WatchDescription {
    wd: number;
    watcher: InotifyDescription;
    path: string;
    node: Inode;
    mask: number;
}

function isOpenFileDescription(file: OpenFileDescription | InotifyDescription): file is OpenFileDescription {
    return file.kind === "open";
}

function isInotifyDescription(file: OpenFileDescription | InotifyDescription): file is InotifyDescription {
    return file.kind === "inotify";
}

function isReadable(file: OpenFileDescription) {
    return (file.flags & constants.O_ACCMODE) !== constants.O_WRONLY;
}

function isWritable(file: OpenFileDescription) {
    return (file.flags & constants.O_ACCMODE) !== constants.O_RDONLY;
}

interface WatchedFile {
    path: string;
    handle: any;
    previous: Stats;
    listener: (current: Stats, previous: Stats) => void;
}

function parseFlags(flags: string | number) {
    if (typeof flags === "string") {
        switch (flags) {
            case "r": return constants.O_RDONLY;
            case "r+": return constants.O_RDWR;
            case "rs+": return constants.O_RDWR;
            case "w": return constants.O_WRONLY | constants.O_TRUNC | constants.O_CREAT;
            case "wx": return constants.O_WRONLY | constants.O_TRUNC | constants.O_CREAT | constants.O_EXCL;
            case "w+": return constants.O_RDWR | constants.O_TRUNC | constants.O_CREAT;
            case "wx+": return constants.O_RDWR | constants.O_TRUNC | constants.O_CREAT | constants.O_EXCL;
            case "a": return constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
            case "ax": return constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL;
            case "a+": return constants.O_RDWR | constants.O_APPEND | constants.O_CREAT;
            case "ax+": return constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL;
            default: throw new Error(`Unrecognized file open flag: ${flags}`);
        }
    }
    return flags;
}

function resizeBuffer(buffer: Buffer, size: number) {
    if (buffer.byteLength === size) return buffer;
    const newBuffer = Buffer.allocUnsafe(size);
    newBuffer.fill(0, buffer.copy(newBuffer, 0, 0, size));
    return newBuffer;
}