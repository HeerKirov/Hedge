import {sha256, sha224} from "js-sha256"

function encrypt(key: string, json: Object): Buffer {
    let passwd = turnToPasswordSequence(key)
    let flag = turnToFlagSequence(key)
    let passwdBuf = turnToBinary(passwd)
    let data = `DATA:${flag}:${JSON.stringify(json)}`
    let dataBuf = loopChange(turnToBinary(data), 8, 1)
    return xor(dataBuf, passwdBuf)
}
function decrypt(key: string, buf: Buffer): Object {
    let passwd = turnToPasswordSequence(key)
    let flag = turnToFlagSequence(key)
    let passwdBuf = turnToBinary(passwd)
    let decodeBuf = xor(buf, passwdBuf)
    let data = turnToString(loopChange(decodeBuf, 8, -1))
    let prefix = `DATA:${flag}:`
    if(data.length >= prefix.length && data.slice(0, prefix.length) == prefix) {
        return JSON.parse(data.slice(prefix.length))
    }else{
        return null
    }
}
function turnToPasswordSequence(key: string): string {
    return sha224(`photos.${key}.heerkirov.com`)
}
function turnToFlagSequence(key: string): string {
    return sha256(`photos.${key}.heerkirov.com`)
}
/**
 * 将字符串转换为buffer。
 * @param key 
 */
function turnToBinary(key: string): Buffer {
    return Buffer.from(key)
}
/**
 * 将buffer转换回字符串。
 * @param binary 
 */
function turnToString(binary: Buffer): string {
    return binary.toString()
}
/**
 * 对buffer进行循环更替。每最多groupSize个字节位一组，组内进行循环移位。
 * @param arr buffer。
 * @param groupSize 组的大小。
 * @param step 向右循环移位的位移。为负数时向左。
 */
function loopChange(arr: Buffer, groupSize: number, step: number): Buffer {
    let length = arr.length
    let ret = Buffer.alloc(length)
    for(let i = 0; i < length; ++i) {
        let head = Math.floor(i / groupSize) * groupSize
        let tail = head + groupSize
        if(tail > length) tail = length
        let goal = i - step
        while(goal < head) goal += tail - head
        while(goal >= tail) goal -= tail - head
        ret[i] = arr[goal]
    }
    return ret
}
/**
 * 异或两个buffer。这个异或以data为基准，key会循环使用。
 * @param data 
 * @param key 
 */
function xor(data: Buffer, key: Buffer): Buffer {
    let ret = Buffer.alloc(data.length)
    for(let i = 0, j = 0; i < data.length; ++i, ++j) {
        if(j >= key.length) j = 0
        let byte = data[i], byte1 = key[j]
        ret[i] = byte ^ byte1
    }
    return ret
}
/**
 * 生成uuid。
 * @param len 
 * @param radix 
 */
function uuid(len, radix) {
    var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
    var uuid = [], i;
    radix = radix || chars.length;
 
    if (len) {
      // Compact form
      for (i = 0; i < len; i++) uuid[i] = chars[0 | Math.random()*radix];
    } else {
      // rfc4122, version 4 form
      var r;
 
      // rfc4122 requires these characters
      uuid[8] = uuid[13] = uuid[18] = uuid[23] = '-';
      uuid[14] = '4';
 
      // Fill in random data.  At i==19 set the high bits of clock sequence as
      // per rfc4122, sec. 4.1.5
      for (i = 0; i < 36; i++) {
        if (!uuid[i]) {
          r = 0 | Math.random()*16;
          uuid[i] = chars[(i == 19) ? (r & 0x3) | 0x8 : r];
        }
      }
    }
 
    return uuid.join('');
}

export {turnToBinary, turnToString, loopChange, xor, encrypt, decrypt, uuid}