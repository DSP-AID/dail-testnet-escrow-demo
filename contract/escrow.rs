// DAiL bnty_0450 — minimal NEAR escrow contract, no_std/no_alloc, no dependencies.
// ABI: near-sys register interface (module "env"), as used by near-sdk 5 contracts.
// Lifecycle: new(seller_id) -> deposit (buyer locks funds) -> deliver (seller marks done)
//            -> release (buyer approves; contract transfers locked funds to seller).
#![no_std]
use core::panic::PanicInfo;

#[link(wasm_import_module = "env")]
extern "C" {
    fn read_register(register_id: u64, ptr: u64);
    fn register_len(register_id: u64) -> u64;
    fn predecessor_account_id(register_id: u64);
    fn input(register_id: u64);
    fn attached_deposit(balance_ptr: u64);
    fn value_return(value_len: u64, value_ptr: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
    fn log_utf8(len: u64, ptr: u64);
    fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
    fn promise_batch_action_transfer(promise_index: u64, amount_ptr: u64);
    fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
    fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
    fn storage_has_key(key_len: u64, key_ptr: u64) -> u64;
}

#[panic_handler]
fn on_panic(_: &PanicInfo) -> ! {
    die("panic")
}

const MAX_ID: usize = 64;
const MAX_INPUT: usize = 512;
const REG_IN: u64 = 0;
const REG_PRED: u64 = 1;
const REG_TMP: u64 = 2; // scratch register for storage ops / reads

fn die(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

fn log(msg: &str) {
    unsafe { log_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

/// Copy register content into buf, return length. Dies if the value does not fit.
fn reg_to_buf(reg: u64, buf: &mut [u8]) -> usize {
    let n = unsafe { register_len(reg) };
    if n == u64::MAX {
        die("missing register");
    }
    if n as usize > buf.len() {
        die("value too long");
    }
    unsafe { read_register(reg, buf.as_mut_ptr() as u64) };
    n as usize
}

fn read_input(buf: &mut [u8; MAX_INPUT]) -> usize {
    unsafe { input(REG_IN) };
    reg_to_buf(REG_IN, buf)
}

fn read_pred(buf: &mut [u8; MAX_ID]) -> Option<&[u8]> {
    unsafe { predecessor_account_id(REG_PRED) };
    let n = reg_to_buf(REG_PRED, buf);
    if n == 0 { None } else { Some(&buf[..n]) }
}

/// Extract the raw bytes of `"key":"value"` from JSON-ish input (no escapes expected).
fn json_str<'a>(src: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
    let mut pat = [0u8; 64];
    if key.len() + 2 > pat.len() {
        return None;
    }
    pat[0] = b'"';
    pat[1..1 + key.len()].copy_from_slice(key);
    pat[1 + key.len()] = b'"';
    let plen = key.len() + 2;
    let mut i = 0;
    while i + plen <= src.len() {
        if &src[i..i + plen] == &pat[..plen] {
            let mut j = i + plen;
            while j < src.len() && (src[j] == b' ' || src[j] == b':') {
                j += 1;
            }
            if j < src.len() && src[j] == b'"' {
                let s = j + 1;
                let mut k = s;
                while k < src.len() && src[k] != b'"' {
                    k += 1;
                }
                return Some(&src[s..k]);
            }
        }
        i += 1;
    }
    None
}

fn store(key: &[u8], val: &[u8]) {
    unsafe {
        storage_write(key.len() as u64, key.as_ptr() as u64, val.len() as u64, val.as_ptr() as u64, REG_TMP);
    }
}

fn stage() -> u8 {
    let mut buf = [0u8; 4];
    if unsafe { storage_has_key(1, b"t".as_ptr() as u64) } == 0 {
        return b'-'; // not initialized
    }
    let n = load(b"t", &mut buf);
    if n == 0 { b'?' } else { buf[0] }
}

fn load(key_bytes: &[u8], buf: &mut [u8]) -> usize {
    if unsafe { storage_has_key(key_bytes.len() as u64, key_bytes.as_ptr() as u64) } == 0 {
        return 0;
    }
    unsafe { storage_read(key_bytes.len() as u64, key_bytes.as_ptr() as u64, REG_TMP) };
    reg_to_buf(REG_TMP, buf)
}

fn require(cond: bool, msg: &str) {
    if !cond {
        die(msg);
    }
}

// ---------------- exports ----------------

#[no_mangle]
pub extern "C" fn r#new() {
    let mut inbuf = [0u8; MAX_INPUT];
    let n = read_input(&mut inbuf);
    require(stage() == b'-', "already initialized");
    let seller = json_str(&inbuf[..n], b"seller_id").unwrap_or(b"");
    require(!seller.is_empty(), "seller_id required");
    require(seller.len() <= MAX_ID, "seller_id too long");
    store(b"s", seller);
    store(b"t", b"0");
    log("dail-escrow: initialized (stage 0 = open)");
}

#[no_mangle]
pub extern "C" fn deposit() {
    require(stage() == b'0', "deposit only when stage 0");
    let mut amount = [0u8; 16];
    unsafe { attached_deposit(amount.as_mut_ptr() as u64) };
    require(amount.iter().any(|&b| b != 0), "attach a non-zero deposit");
    let mut pbuf = [0u8; MAX_ID];
    let buyer = read_pred(&mut pbuf).unwrap_or(b"");
    require(!buyer.is_empty(), "missing predecessor");
    store(b"b", buyer);
    store(b"a", &amount);
    store(b"t", b"1");
    log("dail-escrow: funds locked in escrow (stage 1 = escrowed)");
}

#[no_mangle]
pub extern "C" fn deliver() {
    require(stage() == b'1', "deliver only when stage 1");
    let mut sbuf = [0u8; MAX_ID];
    let sn = load(b"s", &mut sbuf);
    require(sn > 0, "missing seller");
    let mut pbuf = [0u8; MAX_ID];
    let pred = read_pred(&mut pbuf).unwrap_or(b"");
    require(pred == &sbuf[..sn], "only the registered seller may deliver");
    store(b"t", b"2");
    log("dail-escrow: work delivered (stage 2 = delivered)");
}

#[no_mangle]
pub extern "C" fn release() {
    require(stage() == b'2', "release only when stage 2");
    let mut bbuf = [0u8; MAX_ID];
    let bn = load(b"b", &mut bbuf);
    require(bn > 0, "missing buyer");
    let mut pbuf = [0u8; MAX_ID];
    let pred = read_pred(&mut pbuf).unwrap_or(b"");
    require(pred == &bbuf[..bn], "only the buyer may release");
    let mut sbuf = [0u8; MAX_ID];
    let sn = load(b"s", &mut sbuf);
    require(sn > 0, "missing seller");
    let mut amount = [0u8; 16];
    require(load(b"a", &mut amount) == 16, "missing amount");
    store(b"t", b"3"); // guard before cross-contract transfer
    unsafe {
        let p = promise_batch_create(sn as u64, sbuf.as_ptr() as u64);
        promise_batch_action_transfer(p, amount.as_ptr() as u64);
    }
    log("dail-escrow: funds released to seller (stage 3 = released)");
}

#[no_mangle]
pub extern "C" fn status() {
    let mut out = [0u8; 512];
    let mut o = 0;
    fn put(out: &mut [u8], o: &mut usize, s: &[u8]) {
        require(*o + s.len() <= out.len(), "status overflow");
        out[*o..*o + s.len()].copy_from_slice(s);
        *o += s.len();
    }
    put(&mut out, &mut o, b"{\"stage\":");
    let st = stage();
    if st == b'-' || st == b'?' {
        put(&mut out, &mut o, b"null");
    } else {
        put(&mut out, &mut o, &[st]);
    }
    put(&mut out, &mut o, b",\"buyer\":\"");
    let mut bbuf = [0u8; MAX_ID];
    let bn = load(b"b", &mut bbuf);
    put(&mut out, &mut o, &bbuf[..bn]);
    put(&mut out, &mut o, b"\",\"seller\":\"");
    let mut sbuf = [0u8; MAX_ID];
    let sn = load(b"s", &mut sbuf);
    put(&mut out, &mut o, &sbuf[..sn]);
    put(&mut out, &mut o, b"\",\"amount_le_hex\":\"");
    let mut amount = [0u8; 16];
    load(b"a", &mut amount);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in amount.iter() {
        put(&mut out, &mut o, &[HEX[(byte >> 4) as usize], HEX[(byte & 15) as usize]]);
    }
    put(&mut out, &mut o, b"\"}");
    unsafe { value_return(o as u64, out.as_ptr() as u64) };
}
