---
layout: "../../layouts/BlogPost.astro"
title: "A Web Server in x86_64 NASM"
description: "Design, features, and obstacles encountered when developing a web server in x86_64 NASM."
pubDate: "Jan 24 2023"
heroImage: "/rmRadev-Early-Morning.jpg"
---

## Introduction

At 1000 lines of code and just over a month of development time, I can finally say that I'm content where my [assembly web server](https://github.com/igoforth/asmserv) is at. My goal going into this project was to learn more about low-level architecture and optimization while challenging myself with something fun at the same time. I accomplished those goals. However, I found most of my time was spent thinking about execution flow, buffers, verification, and strange bugs.

Assembly forces you to be intentional because, unlike any other language, you manage the stack, heap, and other program sections manually. While this presents some incredible opportunities, the chances you're going to produce something better than a compiler can output is slim to none. I open myself to criticism on whether I handled this level of control appropriately. Regardless, in this blog post I wanted to discuss my design decisions, project features, and the unique obstacles I encountered. I will not and could not break down every line, so I'm assuming whoever is reading this knows at least a little bit about x86.

## Design Decisions

[One Does Not Simply Code in Assembly](https://imgflip.com/i/78d8ym)

The project structure is organized in a standard way. The main folder has subfolders src/ obj/ and bin/ each containing their corresponding source, object, and executable files. Organizing the source files was a different story. The gist is, I separated components into separate files and refactored code so you rarely see the same functionality twice. This challenged me to depart from the monolithic style of my [old assembly web server](https://github.com/igoforth/codesamples/blob/master/x86-64/getpostserver.s) and discern how I can squeeze more purpose out of fewer lines of code.

### How Happy Families Handle Arguments and Errors

The program begins at _start, which is an immediate indicator that I'm not using gcc. The gcc compiler can indeed assemble handwritten code, as long as it follows C calling conventions. One of the most recognized is below (note, only main is necessary and argc and argv are just standard practice).[^1]

```c
int main( int argc, char *argv[] ) { /* code */ }
```

GCC requires the program entrypoint to be the label "main" because it uses _start to perform [crt0](https://en.wikipedia.org/wiki/Crt0). One of the first things I learned is how to handle my own arguments. In this case, since I'm using Linux (assembling with NASM), they were passed to me on the stack as dictated by the System V ABI. See a snippet of _start from main.asm below.

```asm
_start:
        mov     eax,DWORD [rsp]     ; arg value
        cmp     rax,3               ; check for 3 args
        ; according to convention, we can assume r12 is not changed by callee, so we use it to keep track of error codes (could also use rbx?)
        mov     r12,1               ; arguments error: 1
        jne     _end

        mov     rdi,QWORD [rsp+0x10]; take pointer ip str
        mov     rsi,QWORD [rsp+0x18]; take pointer port str
        call    _conv               ; convert args to sockaddr_in struct
        add     rsp,0x18            ; clear shell args
```

You might also notice that I use the register r12 to hold my error codes. According to x86 register modification conventions, r12-r15 (in addition to rbx,rsp,rbp) are not changed by the callee.[^7] Because I am only ever calling the kernel or my own functions, I can trust that they remain unmodified throughout the program.

The program utilizes a parent/child process architecture to speed up client request handling. This takes the form of a "while true" loop starting at the "listen" label in main.asm.

```asm
listen: ; loop connections
        mov     rax,288             ; operator accept4 (for nonblocking capabilities). Only failure case I can think of is a situation where the connection isn't closed by the client immediately. Or, if the client induces a server segfault by causing a blocking write. After the initial request, our program responds and closes the connection. I'll worry about that after my initial implementation.
        movzx   rdi,BYTE [rbp-0x1]  ; socket fd
        xor     rsi,rsi             ; any addr
        xor     rdx,rdx             ; null addrlen
        mov     r10,0o4000          ; SOCK_NONBLOCK
        syscall
        mov     BYTE [rbp-0x2],al   ; connection fd
        mov     rax,57              ; operator fork
        syscall
        movzx   rdi,BYTE [rbp-0x2]  ; connection fd
        cmp     rax,0
        jg      .next
.handle:call    _handle
        jmp     _end
.next:  mov     rax,3               ; operator close
        syscall
        jmp     listen
```

I chose to use the [accept4() syscall](https://man7.org/linux/man-pages/man2/accept.2.html) for this because allows extra socket options. The syscall blocks execution flow until it receives a connection upon which it creates a new socket and sets the SOCK_NONBLOCK flag. Finally, it forks so that the child can handle the request and the parent can keep listening. When the child finishes, it returns and jumps to _end.

The SOCK_NONBLOCK flag is useful because of my web server design. The server receives a single request, fulfills it, then closes the connection. Because the client should only ever write to the socket once, we can implement a subroutine that empties the socket of any data it didn't need simply by having the kernel read() until it returns an error.

```asm
flush: ; this subroutine reads from the socket to /dev/null
; rax: read operator / result
; rdi: connection fd
; rsi: /dev/null
; rdx: read count
        mov     rdx,8
        lea     rsi,[rbp-267]
        movzx   rdi,BYTE [rbp-259]
        mov     rax,0
        syscall
        ret

; below is a section in _get

		; flush socket using read
.clr:   call    chkrd
        cmp     rax,0
        jle     .done2
        call    flush
        jmp     .clr
```

If the flag was not set, the kernel would block execution flow until it receives further data from a read() syscall.

### Network Byte Order and NASM Structs

[Intel Programmer](https://imgflip.com/i/78e09b)

A long time ago, the powers that be decreed that all data exchanged between hosts should be big-endian, lovingly referred to as "network byte order." This was no different from the big-endian "host byte order" used by IBM, Motorola, etc but converse to Intel architecture which used little-endian to sort bytes. C has functions to help us with this. Of course, I chose to not use them.

Before the server can create a socket and listen on a port, it must first translate the command line arguments given by the user into something the kernel can understand. The _conv function does this with the ip_aton and pt_atons subroutines and a handy NASM preprocessor feature.

```asm
ip_aton:                            ; ip ascii to network order (big-endian)
; rax: accumulator
; rdi: ascii pointer
; rsi: network byte order pointer
; rcx: loop counter
; rdx: general purpose
        xor     rax,rax
        xor     rcx,rcx
        mov     cl,4                ; set loop counter
.top:   xor     rdx,rdx
        mov     dl,BYTE [rdi]       ; load char
        cmp     dl,'0'
        jb      .next               ; if not number, next
        sub     dl,'0'
        imul    ax,10               ; multiply accumulator by 10
        add     al,dl               ; add int to accumulator
        jo      _end                ; if accumulator > 255, error
        inc     rdi
        jmp     .top
.next:  mov     BYTE [rsi],al       ; store & clear accumulator
        xor     al,al
        inc     rsi
        inc     rdi
        dec     cl
        jnz     .top
        ret
```

The IP conversion subroutine in particular iterates over a string a byte at a time and adds their integer representation to an accumulator according to its power. When it finds a period, it stores the byte total in the memory location referred to by rsi. If at any point the accumulator's 8-bit register overflows, something has gone seriously wrong and it errors.

The memory location of the IP and other data are part of a sockaddr_in struct that NASM creates with some [preprocessor magic](https://www.nasm.us/xdoc/2.15/html/nasmdoc5.html#section-5.9) This struct type is defined with a preprocessor macro, declared in the .bss section, and initialized in our code. This helps us massively with network byte ordering because structs make big-endian easy. This is because structs in NASM work by addressing the offset of a field from the struct beginning, rather than the end like on the x86 stack. This offset allows us to enter data a byte at a time without using effective addresses according to field size. Below is the representation of the sockaddr_in struct with family AF_INET, port 1485, and IP 127.0.0.1.

```bash
pwndbg> set endian little
The target is set to little endian.
pwndbg> x/16bx 0x403190
0x403190:       0x02    0x00    0x05    0xcd    0x7f    0x00    0x00    0x01
0x403198:       0x00    0x00    0x00    0x00    0x00    0x00    0x00    0x00
pwndbg> x/2gx 0x403190
0x403190:       0x0100007fcd050002      0x0000000000000000
pwndbg> set endian big
The target is set to big endian.
pwndbg> x/16bx 0x403190
0x403190:       0x02    0x00    0x05    0xcd    0x7f    0x00    0x00    0x01
0x403198:       0x00    0x00    0x00    0x00    0x00    0x00    0x00    0x00
pwndbg> x/2gx 0x403190
0x403190:       0x020005cd7f000001      0x0000000000000000
pwndbg>
```

### An Assembly Buffered Reader

A web server is always reading and parsing something. For this, I created an assembly function reminiscent of Java's BufferedReader. The goal of this function is to efficiently parse HTTP requests and extract meaningful data. _read from read.asm takes two arguments: a file descriptor and a delimiter. A delimiter in this case is the character the web server uses to separate data like strings. What makes this function unique? See the basic HTTP request below.

```http
GET /index.html HTTP/1.1
Host: localhost:1485
User-Agent: curl/7.81.0
Accept: */*
```

Right now, the web server only handles GET requests. Therefore, it only needs two things: the request method and the requested file location. In the future, the server will handle POST/PUT by transferring data from the request to a new or existing file. The _read function uses a 256 byte buffer and an offset. When given valid arguments, _read will perform a number of steps:

1. Take in 32 bytes from the file descriptor with the take subroutine
2. Optionally verify bytes against rulesets with the verify function.
3. Iterate the buffer with the seek subroutine, adjusting the offset accordingly
4. Check for buffer fullness or delimiter with the check subroutine
	1. If both are false, repeat 1-4
	2. If the delimiter is found, set the offset to its location
	3. If the buffer is full, shift the buffer upon next _read call (offset will be a null between (buffer size) and (buffer size - 32 bytes))

You might ask, "Why go through all these steps and bother with delimiters if you just need to grab a method and file path? Aren't you overengineering it?" I talk further about the obstacles _read overcomes below. However, the design philisophy of _read is to be flexible and efficient. By separating functionality into subroutines, it would be easy to adapt the function to handle complex headers or configuration files.

Part of the flexibility of _read comes from how it communicates with the rest of the program. It does this through the dx register (the 16-bit register of 64-bit rdx) where it manages its state. I have taken special care to preserve dx over the child's lifecycle. I have commented a legend of its functionality below.

```asm
; dh:  offset
; dl:  handle + read i/o control
; 0000 0001 read security (1)
; 0000 0010 keep verify   (2)
; 0000 0100 read not done (4)
; 0000 1000 verify fail   (8)
```

The upper half of dx holds the buffer offset, which is guaranteed to be 255 bytes (0xff) or less. The lower half holds security options and read status that I manipulate using the operators bt, bts, btr, and btc. The read status bit coupled with the multiple return values offered by the check subroutine allow _read to manage the buffer and allow _get and _verify to understand its contents. All in all, there are many ways I can optimize _read as I add additional features.

## Project Features

Bringing the web server's capabilities to the present day is not a task that can be accomplished in assembly, by one recent grad, in less than a month. The program currently only responds to HTTP 0.9 and one request method. However, there are a couple niceties that I knew I wanted to integrate. These things are byte verification and explicit error handling.

### Byte Safety Through Verification

The goal of _verify in verify.asm is to prevent path traversal when parsing file paths from HTTP requests. It does this through a small (but expandable) ruleset. The two rules given below either totally restrict, or allow only once, bytes that can manipulate an open() syscall. An example of the latter would be the forward slash "/" and period ".". By allowing only one forward slash and period, we should be able to prevent open() from leaving the directory the web server was run from.

```asm
; Forbidden in paths:
; - Spaces " " (0x20) (By nature of the program, this will just break things)
; - More than one dot "." (0x2E)
; - More than one forward slash "/" (0x2F)
; - Bad ASCII bytes \:*?%"<>| (0x5C 0x3A 0x2A 0x3F 0x22 0x3C 0x3E 0x7C)

section .data
r1:     db      0x2E,0,0x2F,0,0     ; no more than one ./

section .rodata
r2:     db      0x5C,0x3A,0x2A,0x3F,0x25,0x22,0x3C,0x3E,0x7C,0       ; never \:*?%"<>|
```

At the moment, each ruleset has its own subroutine. This can be refactored later to more easily support additional rulesets. Since _verify keeps track of state with dx, we solve the problem where we see one "." or "/" in the first 32 bytes, and additional characters in subsequent read loops. The flush subroutine resets the ruleset. If a request violates any rule, a 404 is sent to the client.

[HTTP/1.1 404 Not Found](https://imgflip.com/i/78ij7e)

### Effective Addressing and Error Handling

I am the happiest with where _error in error.asm is at because it's the easiest to extend. As mentioned previously, the r12 register is used to keep track of the program error code. Error codes 1-5 affect the parent and kill the server. Error codes 6-8 affect the child and indicate problems with the client. Initially, I had the unique error strings 16 byte aligned in .rodata as seen in the amalgamation below.

```asm
lea rsi,[section.rodata.start+(rax-1)*32]

section .rodata align=16
error1: db      "Syntax: ./server [ip] [port]",0xa,0
        times 32-$+error1 db 0
error2: db      "Error: Invalid IP or port",0xa,0
        times 32-$+error2 db 0
error3: db      "Error: Socket error",0xa,0
        times 32-$+error3 db 0
error4: db      "Error: Bind error",0xa,0
        times 32-$+error4 db 0
error5: db      "Error: Listen error",0xa,0
        times 32-$+error5 db 0
```

I'll admit, it was creative. But, it didn't work because it's not a valid NASM effective address. Not to mention it limits how long my error messages can be. The revised implementation is below.

```asm
dec     rax
lea     rdx,[ep1]
mov     rsi,[rdx+rax*8]

section .data align=8               ; store error pointers
ep1:    dq      es1
ep2:    dq      es2
ep3:    dq      es3
ep4:    dq      es4
ep5:    dq      es5
ep6:    dq      es6
ep7:    dq      es7
ep8:    dq      es8

section .rodata                     ; store error strings
es1:    db      "Syntax: ./server [ip] [port]",0xa,0
es2:    db      "Error: Invalid IP or port",0xa,0
es3:    db      "Error: Socket error",0xa,0
es4:    db      "Error: Bind error",0xa,0
es5:    db      "Error: Listen error",0xa,0
es6:    db      "Error: Invalid request method",0xa,0
es7:    db      "Error: Invalid path",0xa,0
es8:    db      "Error: File error",0xa,0
```

Though this design deals with extra pointers, I can throw in a new error code with two lines. Plus, it's way more readable.

## Unique Obstacles

Deciding what functionality to separate from main.asm into a component, from a component to a function, and from a function into a subroutine was difficult. This was exacerbated by the mild "feature creep" the project suffered from. To get the program to do what I wanted required a lot more structure than I had thought initially. I'm inspired by modern programming methodologies like Agile and Extreme Programming. So, choosing to "refactor early, refactor often", when to "K.I.S.S", and when to optimize code for scalability was painful but part of the fun. Following are a few obstacles I encountered and how I dealt with them.

### I've Seen Too Much! (Read Buffer)

**My implementation**
The read syscall takes 32 bytes at a time into a buffer 256 bytes in size. I utilize the offset to describe either how full the buffer is or the location of the delimiter. This makes the memory footprint incredibly small because the program can efficiently search for and use only the data it needs while discarding the rest.

**The obstacle**
If there is a read that exceeds the delimited segment (indicated by offset), there will be extra content in the buffer up to the read size. This means that if the buffer is cleared incorrectly before subsequent reads, some data will be lost.

**How I overcame it**
The shift subroutine will take any content from offset to the closest null and bring it to the beginning of the buffer. We zero out unused buffer content after every shift. This is because an offset not indicating the delimiter must be null. Finally, it will set the offset to the end of the preserved bytes. This means the offset again indicates buffer fullness instead of the delimiter. The program only needs to understand that in the previous read the delimiter was found. It requires no knowledge of the state of the buffer beyond the value of the offset.

```asm
shift:  ; this subroutine brings all bytes from offset to null to front of buffer
; we are considering the potential that we read more into the buffer than it takes to find the delimiter (specified by the offset), so we save the extra content past offset for the next read
; r8:  offset pointer
; r9:  buf pointer
; r10: general register
        ; prologue
        push    rax
        push    rdi
        push    rcx
        xor     r8,r8
        xor     r9,r9
        xor     r10,r10

        ; body
        xchg    dl,dh
        movzx   r10,dl
        xchg    dh,dl
        lea     r9,[_buf]
        cmp     r10,223
        jge     .zero               ; if buffer > BUF_SIZE - MAX_READ, just zero it
        mov     r8b,BYTE [_buf+r10]
        test    r8b,r8b             ; if buffer offset value is not zero, we need to add one (presuming here the value is the delimiter) to start properly at next section
        jz      .i
        inc     r10
.i:     lea     r8,[_buf+r10]
.top:   mov     r10b,BYTE [r8]
        test    r10b,r10b
        jz      .zero
        mov     BYTE [r9],r10b      ; if byte is not null, bring it to front
        inc     r8
        inc     r9
        jmp     .top
.zero:  lea     r8,[_buf]
        sub     r9,r8
        xchg    dl,dh
        mov     dl,0                ; new offset
        xchg    dh,dl
        mov     r8,0xff
        sub     r8,r9

        ; rep stosb stores rax in memory up to count rcx
        mov     cl,r8b              ; null count
        xor     rax,rax
        lea     rdi,[_buf+r9]
        rep stosb                   ; zero rest of buffer

        ; epilogue
.dna:   pop     rcx
        pop     rdi
        pop     rax
        ret
```

In the scenario that _read is also handling POST/PUT data or file data that is longer than 256 bytes long, our execution flow looks something like this:

The handler should exit its loop calling _read if
1. The offset is the delimiter (in the case of a text file, null)
The handler should send buffer data (like file content) back to client if
2. The offset is greater than BUF_SIZE - MAX_READ (indicating a full buffer, but NOT the end of the file)

_read knows to align (shift subroutine) if
1. The offset is not null (indicating a found delimiter)
OR
2. The offset is greater than BUF_SIZE - MAX_READ

**Failure case(s)**
- The user sends multiple delimiters (like whitespace 0x20) sequentially. The handler is prepared to read from buffer but the offset is 0. In this case, the program should error.
- The handler has to call _read multiple times for anything other than DATA. A path SHOULD be read in one call, because linux max is 255B. DATA may be read multiple times because we can write to a socket multiple times in one response.
- Buffer contents must be acted upon before the buffer is cleared. If, for some reason, we have content greater than buffer size that cannot be intermediately stored on the stack, our design fails.

**Alternatives I've considered**
- Reading from a HTTP request into memory (such as the stack or a buffer) until you reach the end of the request. Then, parse the total content for methods, headers, file paths, and data. As far as I know, many web servers do this.  However, with so many memory accesses, you run the risk of slowdown because data exceeds the capacity of the L1 cache. This could mean the difference between 3-5 cycle latency and 8-20 cycle latency.[^2] In addition, you increase your attack surface because of how much data you're storing for a longer period of time.
- Syscalling read from a HTTP request byte by byte. This allows careful allocation and parsing of strings. However, in exchange you gain "extremely" long processing time since control is given to the kernel every loop. This could mean a context switch, which is thousands of cycles.[^3] Granted, Linux may offer system calls I don't know about that tackle this efficiently.

### I Didn't Finish Sending It! (SO_LINGER)

**My implementation**
Once a GET request is verified, the file path is interpreted and opened by _get in get.asm. Finally, a descriptor is passed to the system call sendfile() to transmit to the client. Immediately after sendfile() returns, the child handling the connection exits.

**The obstacle**
During testing I would sometimes not receive content from the server before the connection was closed. This happened nondeterministically, but most often on larger requests.

**How I overcame it**
It was clear that sendfile() returns early and doesn't wait for a TCP acknowledgement from the client. This is fair, as its business is to send files and not to handle a socket. It's also possible it returned immediately because the socket was nonblocking. Through an exellent suggestion from a member of the OSDev Discord, I discovered the SO_LINGER flag.

```asm
        ; set socket option SO_LINGER
        mov     r8,8                ; struct length 8 bytes
        ; struct linger {
        ;     int l_onoff;    /* linger active */
        ;     int l_linger;   /* how many seconds to linger for */
        ; };
        mov     rax,0x100000001     ; SO_LINGER struct
        push    rax
        lea     r10,[rsp]           ; set boolean to true
        mov     rdx,13              ; SO_LINGER (wait around until all data is sent for 200 ms even after calling exit())
        mov     rsi,1               ; SOL_SOCKET (edit socket api layer)
        xor     rax,rax
        mov     rax,54              ; operator setsockopt
        syscall
```

This flag is a magic socket option that, when enabled, "a close(2) or shutdown(2) will not return until all queued messages for the socket have been successfully sent or the linger timeout has been reached."[^4] I can just exit() and let the kernel handle the rest.

**Failure case(s)**
- The user expects multiple files or a complex response, which the server is not designed to handle.

As a result, I didn't have to bother with nanosleep(), checking TCP status, or even closing the socket.

**Alternatives I've considered**
- I briefly experimented with ioctl() to check the status of the TCP socket. The correct way to deal with complex non-blocking sockets is to have prior knowledge about what messages to expect. Ioctl() as a system call was designed to allow a program to check and change underlying device parameters using special encoded arguments.[^5] In our case, we used TIOCOUTQ and TIOCINQ to check the input & output queue size not sent and not acked.[^6]
- I could've guessed how long the message would take to transmit. I would call nanosleep() for a max length of time I'm comfortable with. Obviously this method is the equivalent of bruteforcing a password hash. You shouldn't if you don't have to.

## Conclusion

The right design depends on a variety of factors, such as your hardware and the complexity of your program. Unless you're developing code where microseconds is mission-critical, arguing for a design that means the difference between a dozen CPU cycles is semantics. As mentioned in my previous blog post, the Intel SDM and various optimization guides are on my reading list for good reason.

I do minimal research when approaching projects like this to encourage experimentation and growth. I learned so much that, over the course of the month, my latest code looked completely different from my starting code. As much as I argue for the advantages of my implementation, I only know so much. In hindsight, I held onto memory and registers too tightly for the amount of syscalls the program has.

Initially, my goal was to write a server in both x86_64 Assembly and C. This was so that I could compare a single design to my implementation and what a compiler produces. While writing the C web server didn't fit into my schedule before my self-imposed deadline, I hope to continue experimenting in [Godbolt](https://godbolt.org/) and someday fully realize that vision. Please look out for additional blog posts as I look forward to giving back to the community that has done so much for me.

[^1]: [Wikipedia - Entry Point - C and C++](https://en.wikipedia.org/wiki/Entry_point#C_and_C++)
[^2]: [How many machine cycles does it take a CPU to fetch a value from the SRAM cache](https://qr.ae/prXPs5)
[^3]: [Operation Costs in CPU Clock Cycles](https://news.ycombinator.com/item?id=12933838)
[^4]: [Linux Manual - socket](https://man7.org/linux/man-pages/man7/socket.7.html)
[^5]: [Linux Manual - ioctl](https://man7.org/linux/man-pages/man2/ioctl.2.html)
[^6]: [Elixir - Linux v6.1.8 - sockios.h](https://elixir.bootlin.com/linux/v4.0/source/include/uapi/linux/sockios.h#L25)
[^7]: [X86 Register Modification Conventions](https://www.cs.binghamton.edu/~tbartens/CS220_Spring_2019/lectures/L15_x86_CallingConventions.pdf)