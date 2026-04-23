    ORG 100h

    JMP   main

add:
    SHLD  __a_2_add
    LHLD  __a_1_add
    PUSH  H
    LHLD  __a_2_add
    POP   D
    DAD   D
    RET

main:
    LXI   H,3
    SHLD  __a_1_add
    LXI   H,4
    CALL  add
    RET


__static_stack:
    DS   4  ; add
__s_add: EQU __static_stack+0
__a_1_add: EQU __s_add+0
__a_2_add: EQU __s_add+2
__s_main: EQU __static_stack+4
    END
