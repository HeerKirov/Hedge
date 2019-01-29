import {close, existsSync, mkdirSync, open, read, readFileSync, write, writeFileSync} from 'fs'
import {
    DataEngine, Illustration,
    IllustrationFindOption, TagFindOption, ImageSpecification,
    caseIllustration, caseTag,
    sortIllustration, sortTag,
} from './engine'
import {Formula} from './appStorage'
import {decrypt, encrypt, encryptBuffer, decryptBuffer} from '../util/encryption'
import {translateDataURL, PREFIX_LENGTH, PREFIX} from '../util/nativeImage'
import {Arrays, Maps, Sets} from "../util/collection";

const STORAGE = 'data.db'
const BLOCK_SIZE = 1024 * 64 //64KB
const BLOCK_IN_FILE = 1024 //1024 blocks(64MB) in max case
function FILE_NAME(index: number): string {
    return `block-${(index + 0xa).toString(16)}.dat`
}

class LocalDataEngine implements DataEngine {
    constructor(private storageFolder: string, private key: string) { }

    findIllustration(options: IllustrationFindOption): Illustration[] {
        let illustrations = Arrays.filterMap(this.memory.illustrations, (illust) => {
            let result = caseIllustration(illust, options)
            return result != null ? result : undefined
        })
        if(Arrays.isNotEmpty(options.order)) {
            sortIllustration(illustrations, options.order, options.desc)
        }
        return illustrations
    }
    createIllustration(illustrations: Illustration[]): Illustration[] {
        for(let illust of illustrations) {
            if(!illust.id) {
                illust.id = this.memory.stepToNextIllustrationId()
            }
            for(let image of illust.images) {
                if(!image.id) {
                    image.id = this.memory.stepToNextImageId()
                }
            }
            Arrays.append(this.memory.illustrations, illust)
            for(let tag of illust.tags) {
                Sets.put(this.memory.tags, tag)
            }
            for(let image of illust.images) {
                for(let tag of image.subTags) {
                    Sets.put(this.memory.tags, tag)
                }
            }
        }
        return illustrations
    }
    updateIllustration(illustrations: Illustration[]): Illustration[] {
        let success = []
        for(let illust of illustrations) {
            let index = Arrays.indexOf(this.memory.illustrations, (t) => t.id === illust.id)
            if(index >= 0) {
                this.memory.illustrations[index] = illust
                Arrays.append(success, illust)
                for(let tag of illust.tags) {
                    Sets.put(this.memory.tags, tag)
                }
                for(let image of illust.images) {
                    for(let tag of image.subTags) {
                        Sets.put(this.memory.tags, tag)
                    }
                    if(!image.id) {
                        image.id = this.memory.stepToNextImageId()
                    }
                }
            }
        }
        return success
    }
    deleteIllustration(illustrations: (Illustration | number)[]): number {
        let delNumber = 0
        for(let ii of illustrations) {
            let id = typeof ii === "number" ? ii : ii.id
            let index = Arrays.indexOf(this.memory.illustrations, (t) => t.id === id)
            if(index >= 0) {
                Arrays.removeAt(this.memory.illustrations, index)
                delNumber++
                this.imageURLCache.remove(id)
                this.memory.blocks[id] = undefined
                //TODO 在删除时，需要删除block表，并将空出来的block记入unused。
            }
        }
        return delNumber
    }

    findTag(options: TagFindOption): string[] {
        let ret = Arrays.filterMap(this.memory.tags, (tag) => {
            return caseTag(tag, options) ? tag : undefined
        })
        if(Arrays.isNotEmpty(options.order)) {
            sortTag(ret, options.order, options.desc)
        }
        return ret
    }
    saveImageURL(imageId: number, dataURL: string, callback?: () => void): void {
        if(dataURL.substr(0, PREFIX_LENGTH) === PREFIX) {
            dataURL = dataURL.substring(PREFIX_LENGTH)
        }
        let buf = encryptBuffer(this.key, Buffer.from(dataURL, 'base64'))
        saveImageBuffer(this.storageFolder, buf, () => this.memory.stepToNextBlockIndex(), (blocks) => {
            if(!this.memory.blocks[imageId]) this.memory.blocks[imageId] = {}
            this.memory.blocks[imageId][ImageSpecification.Origin] = {
                size: buf.byteLength,
                blocks: blocks
            }
            let exhibitionURL = translateDataURL(dataURL, ImageSpecification.Exhibition).substring(PREFIX_LENGTH)
            let exhibitionBuf = encryptBuffer(this.key, Buffer.from(exhibitionURL, 'base64'))
            saveImageBuffer(this.storageFolder, exhibitionBuf, () => this.memory.stepToNextBlockIndex(), (blocks) => {
                if(!this.memory.blocks[imageId]) this.memory.blocks[imageId] = {}
                this.memory.blocks[imageId][ImageSpecification.Exhibition] = {
                    size: exhibitionBuf.byteLength,
                    blocks: blocks
                }
                if(callback != undefined) callback()
            })
        })

    }
    loadImageURL(imageId: number, specification?: ImageSpecification, callback?: (string: string) => void): void {
        let spec = specification === ImageSpecification.Origin ? ImageSpecification.Origin : ImageSpecification.Exhibition
        let cache = this.imageURLCache.get(spec, imageId)
        if(cache != null) {
            if(callback !== undefined) callback(cache)
            return
        }
        if(!this.memory.blocks[imageId]) {
            if(callback != undefined) callback(null)
            return
        }
        let {blocks, size} = this.memory.blocks[imageId][spec]
        if(!blocks) {
            if(callback !== undefined) callback(null)
        }else{
            loadImageBuffer(this.storageFolder, blocks, size, (buf: Buffer) => {
                if(buf != null) {
                    let dataUrl = PREFIX + decryptBuffer(this.key, buf).toString('base64')
                    this.imageURLCache.set(spec, imageId, dataUrl)
                    if(callback !== undefined) callback(dataUrl)
                }else{
                    if(callback !== undefined) callback(null)
                }
            })
        }
    }

    getConfig(key: string): any {
        return this.memory.config[key]
    }
    putConfig(key: string, value: any): void {
        this.memory.config[key] = value
    }
    existConfig(key: string): boolean {
        return key in this.memory.config
    }

    connect(): boolean {
        return this.load()
    }
    close(): void {
        this.save()
    }
    load(): boolean {
        if(existsSync(`${this.storageFolder}/${STORAGE}`)) {
            let buf = readFileSync(`${this.storageFolder}/${STORAGE}`)
            let data = decrypt(this.key, buf)
            if(data != null) {
                let version = data['version']
                //version 在这个版本中并没有什么作用。后续版本如果要做不向后兼容的数据结构变动，需要通过version来告知。

                this.memory.illustrations = data['illustrations']
                let {nextIllustrationId, nextImageId, nextBlockIndex} = data['nextIndex']
                this.memory.nextIllustrationId = nextIllustrationId
                this.memory.nextImageId = nextImageId
                this.memory.nextBlockIndex = nextBlockIndex

                this.memory.blocks = data['blocks']
                this.memory.unusedBlocks = data['unusedBlocks']
                if('config' in data) this.memory.config = data['config']
                this.memory.tags = []
                for(let illust of this.memory.illustrations) {
                    for(let tag of illust.tags) {
                        Sets.put(this.memory.tags, tag)
                    }
                    for(let image of illust.images) {
                        for(let tag of image.subTags) {
                            Sets.put(this.memory.tags, tag)
                        }
                    }
                }
                return true
            }
            return false
        }else{
            if(!existsSync(this.storageFolder)) {
                try{
                    mkdirSync(this.storageFolder)
                }catch (e) {
                    //resume
                }
            }
            this.memory.nextIllustrationId = 1
            this.memory.nextImageId = 1
            this.memory.nextBlockIndex = 0
            this.memory.blocks = []
            this.memory.unusedBlocks = []
            this.memory.tags = []
            this.memory.illustrations = []
            this.memory.config = {}
            return true
        }
    }
    save() {
        let buf = encrypt(this.key, {
            version: "v0.2.0",
            nextIndex: {
                nextIllustrationId: this.memory.nextIllustrationId,
                nextImageId: this.memory.nextImageId,
                nextBlockIndex: this.memory.nextBlockIndex
            },
            illustrations: this.memory.illustrations,
            blocks: this.memory.blocks,
            unusedBlocks: this.memory.unusedBlocks,
            config: this.memory.config
        })
        try {
            mkdirSync(this.storageFolder) //该方法并不可以递归创建文件夹。
        }catch (e) {
            //resume
        }
        writeFileSync(`${this.storageFolder}/${STORAGE}`, buf)
    }

    private memory: SaveModel = new SaveModel()                     //缓存所有与数据库内容有关的内容

    private imageURLCache: BufferCache<string> = new BufferCache()  //缓存已经提取的dataURL的缓存器
}

class SaveModel {
    nextIllustrationId: number          //下一个将被使用的illust id
    nextImageId: number                 //下一个将被使用的image id
    nextBlockIndex: number              //下一个将被使用的block index
    unusedBlocks: number[]              //那些曾经被使用过后来又释放出来的、待继续使用的block index

    tags: string[]                      //缓存所有tags的数据组
    illustrations: Illustration[]       //缓存illust数据库
    blocks: Object                      //number(imageId) -> {spec: {blocks: number[], size: number}} block index array的缓存映射

    config: Object                      //杂项类的配置信息

    stepToNextIllustrationId(): number {
        return this.nextIllustrationId++
    }
    stepToNextImageId(): number {
        return this.nextImageId++
    }
    stepToNextBlockIndex(): number {
        if(Arrays.isNotEmpty(this.unusedBlocks)) {
            return this.unusedBlocks.splice(0, 1)[0]
        }
        return this.nextBlockIndex++
    }
}

class BufferCache<T> {
    constructor() {
        this.memory = {}
        this.memory[ImageSpecification.Thumbnail] = {}
        this.memory[ImageSpecification.Exhibition] = {}
        this.memory[ImageSpecification.Origin] = {}
    }

    get(specification: ImageSpecification, id: number): T {
        return this.memory[specification][id]
    }
    set(specification: ImageSpecification, id: number, obj: T) {
        this.memory[specification][id] = obj
    }
    remove(id: number): boolean {
        let f = false
        if(Maps.remove(this.memory[ImageSpecification.Thumbnail], id)) f = true
        if(Maps.remove(this.memory[ImageSpecification.Exhibition], id)) f = true
        if(Maps.remove(this.memory[ImageSpecification.Origin], id)) f = true
        return f
    }

    private readonly memory: {}
}

class LocalFormula implements Formula {
    constructor(id?: string, key?: string, storage?: string) {
        this.type = 'local'
        if(id) this.id = id
        if(key) this.key = key
        if(storage) this.storage = storage
    }
    type: string
    id: string
    key: string
    storage: string
    buildEngine(): DataEngine {
        try {
            return new LocalDataEngine(this.storage, this.key)
        }catch(e) {
            return null
        }
    }
}

function loadImageBuffer(folder: string, blocks: number[], size: number, callback?: (Buffer) => void): void {
    let map = {}
    for(let i = 0; i < blocks.length; ++i) {
        let block = blocks[i]
        let filename = `${folder}/${FILE_NAME(Math.floor(block / BLOCK_IN_FILE))}`
        if(filename in map) {
            let arr = map[filename]
            arr[arr.length] = {id: i, block: block % BLOCK_IN_FILE, size: (i === blocks.length - 1) ? size % BLOCK_SIZE : BLOCK_SIZE}
        }else{
            map[filename] = [{id: i, block: block % BLOCK_IN_FILE, size: (i === blocks.length - 1) ? size % BLOCK_SIZE : BLOCK_SIZE}]
        }
    }
    let buf = Buffer.alloc(size)
    for(let filename in map) {
        let blocks = map[filename]
        let flag = blocks.length
        open(filename, 'r', (err, fd) => {
            for(let {id, block, size} of blocks) {
                read(fd, buf, id * BLOCK_SIZE, size, block * BLOCK_SIZE, (err, read, buffer) => {
                    flag -= 1
                    if(flag <= 0) {
                        if(callback !== undefined) callback(buf)
                        close(fd, () => {})
                    }
                })
            }
        })
    }
}
function saveImageBuffer(folder: string, buffer: Buffer, nextBlockIndex: () => number, callback?: (Array) => void): void {
    let blockNum = Math.floor(buffer.byteLength / BLOCK_SIZE) + 1
    let blocks = []
    for(let i = 0; i < blockNum; ++i) {
        blocks[i] = nextBlockIndex()
    }
    let map = {}
    for(let i = 0; i < blocks.length; ++i) {
        let block = blocks[i]
        let filename = `${folder}/${FILE_NAME(Math.floor(block / BLOCK_IN_FILE))}`
        if(filename in map) {
            let arr = map[filename]
            arr[arr.length] = {id: i, block: block % BLOCK_IN_FILE, size: (i === blocks.length - 1) ? buffer.byteLength % BLOCK_SIZE : BLOCK_SIZE}
        }else{
            map[filename] = [{id: i, block: block % BLOCK_IN_FILE, size: (i === blocks.length - 1) ? buffer.byteLength % BLOCK_SIZE : BLOCK_SIZE}]
        }
    }
    for(let filename in map) {
        let mapBlock = map[filename]
        let flag = mapBlock.length
        open(filename, 'a', (err, fd) => {
            if(err) console.log(err)
            for(let {id, block, size} of mapBlock) {
                write(fd, buffer, id * BLOCK_SIZE, size, block * BLOCK_SIZE, (err, read, buf) => {
                    flag -= 1
                    if(flag <= 0) {
                        if(callback != undefined) callback(blocks)
                        close(fd, () => {})
                    }
                })
            }
        })
    }
}

export {LocalDataEngine, LocalFormula}