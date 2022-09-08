---
layout: "../../layouts/BlogPost.astro"
title: "An Enterprise Network in a Home Environment"
description: "A short writeup detailing my final HomeLab design and specifications."
pubDate: "Jan 01 2021"
# heroImage: "/placeholder-hero.jpg"
---

## Intro

Roughly 2020, I knew I wanted to step towards being a marketable Cyber Security professional. After all, the Cyber Security industry was experiencing rapid growth. Companies historically had two choices: Either pay a premium for knowledgeable professionals or spend the time and money training existing colleagues. Today, higher education still isn't filling the talent gap; most formal classes rely on tried and true Computer Science Degrees. Topics like databases, systems, and networks end up taking the sidelines. Due to this, I found self-study a worthwhile pursuit. I eventually discovered I learn best in the thick of it with a concrete deadline.

I decided to turn this passion into a personal hobby. I began following a pre-existing community of like-minded people called “homelabbers.” Homelabbers would obtain used enterprise hardware and set it up in their own home as a “homelab.” They could be doing it to learn, for their own business, or for fun. For myself, I wanted to see the impact of my work. So, I planned to build a secure network behind which I had the freedom to expand and do whatever I desired. Using plenty of inspiration from homelabbers, I created a network plan.

## Plan

![HomeLab Network Diagram](/o7ZXP8.png)

In this diagram is a legend of 8 VLANs and several boxes. The top 4 boxes indicate, through a wireless or wired LAN connection, which devices reside in which VLANs. The 5 boxes below separate the services which reside on server-created VLANs. The path to the internet and VLAN legend are on the right.

After extensive research, taking both goals and budget into consideration, I decided on the following equipment:

* HP DL380p Gen8 with 64 GB DDR3 RAM and 4 TB storage
* VMUG Advantage Membership
* Dell OptiPlex 3010 with 4 GB DDR3 RAM and 256 GB storage
* HP T620 Thin Client with Windows 10 Embedded
* HP V1910-24G layer-3 capable switch with 24 ports
* Ubiquiti Unifi 6 Lite access point
* A myriad of cables

## Appliances

I chose OPNSense for my firewall because of its enterprise-grade support, updates, and features. OPNSense was put on the OptiPlex 3010 because 4 GB RAM and 256 GB storage provided more than enough for what I needed. I configured the VLANs shown in the diagram on OPNSense. As part of the configuration, all traffic between my firewall and switch was tagged and utilized a dynamic link aggregated between 4 copper ethernet cables. I also installed advanced OPNSense capabilities like IDS + IPS, RADIUS with LDAP support, and WireGuard (a modern VPN solution) for remote access. These were accessible through plugins. In the future, I hope to increase the robustness of the firewall rules for each VLAN by configuring it according to the principle of least privilege. I also hope to experiment with NGINX, reverse proxies, and multiple firewalls to set up web-facing applications.

The switch I used had a decent featureset. I elected to ignore the routing capabilities because OPNSense was more than capable. I chose to use 6 to 12 of the available 24 ethernet ports for my various endpoints. Configuring VLAN tagging to properly traffic was difficult but rewarding. I attempted to set up authorization between the switch and the RADIUS server on the firewall but, due to outdated software, I was not able to do so. The cables from the firewall and server (more below) connect to trunk ports on the switch.

I chose the 8th generation of HP 2U rack servers specifically because it was the most cost-effective for my price range (about $300-400 on eBay). I later bought the RAM and storage based on how much I estimated the project required. The HP DL380p uses an integrated P420i RAID and storage controller which I configured to manage 8 1TB hard drives in RAID 10, leaving me 4 TB of storage. Despite a 50% reduction in disk space, I decided to do this because of RAID speed and drive lifetime concerns. The network controller that came with the server had two 10 Gbps RJ-45 ethernet ports. I had no plans to adopt 10 Gbps, so I connected two static link aggregated 1 Gbps cables to my switch. I chose to put ESXi 6.5 U3 on the server. This came with my VMUG Advantage Membership.

## Services

My project was security-focused. Cognizant of that, I realized my planned services had a large attack surface. To enforce proper segregation, I decided to use a virtual machine (VM) + docker container hybrid approach. Each virtual machine would represent a category. Each VM would host several docker containers. Each VM category would belong to one VLAN. For instance, I had a “management” VM on management VLAN 4 running 4 docker containers: Ubiquiti Network Controller, Pi-hole DNS, Ansible, and Grafana. For this VM, I allocated 4 vCPUs and 80 GB of storage. All of this was to create less of a headache for myself in the future by making upgrading, maintenance, and communication between services easier.

I encountered many challenges. For instance, I had cooperative services running on separate virtual machines that required access the same storage to function properly. To rectify this, I created a “storage” virtual machine running TrueNAS Community Edition. I allocated it 8 vCPUs and almost all the hard drive space (3.8 TB). In TrueNAS I created a share containing 95% of this space (3.61 TB) and opened it up to the other virtual machines using NFSv4. I recognize that this is not the most efficient way to handle storage. A better solution would be to allow ESXi to handle the sharing of storage between virtual machines or, even better, put TrueNAS on bare metal as a storage server. However, given my limited time, I decided to compromise.

By the end of December, I had hoped to fully set up Microsoft Exchange, Active Directory, and Active Directory Certificate Services. These would have been in a separate virtual machine managed by Windows Admin Center. Unfortunately, I only had the time to set up a minimal Active Directory installation. Setting up an Exchange server was shelved not only because it's complicated and out-of-scope, but also because it's very difficult to do properly. I didn't have time to maintain a public IP reputation to ensure I didn't have domains like Gmail, Yahoo, etc. add me to their blacklist.

The Ubiquiti ecosystem makes an enterprise wi-fi setup simple. The setup completed so far paved the way for the ubuquiti network controller. After purchasing an access point, it was trivial to setup enterprise-grade features like RADIUS/LDAP support and WPA3 Enterprise security. As can be seen in the network diagram, I had 3 VLANs connected to 3 separate Wi-fi networks. I protected the personal network with WPA3 and authorized my RADIUS server to approve connection requests from my wireless devices. The IoT network utilized WPA2 because the majority of IOT devices do not support WPA3. There was a way to get around this using MAC address verification, but I felt that was insecure because a random 14-digit password is much more difficult to bypass than a spoofed MAC address. Finally, the guest network was WPA3-protected with access to only the internet and nothing else. In the future I might add a guest portal and ticket system for user convenience. 

## Conclusion

Overall, this was a fun, educational, and rewarding project. It was also a marathon. I spent a month at about 8-10 hours per day to get it done. The only reason I stopped was becuase I had to return to college. I learned a lot about systems administration, networks, and network security best-practices. However, it wasn't without its frustrations. Several times I resisted the urge to bang my head against a wall. Several times I celebrated as I finally got past a roadblock. In the end, my passion for cyber security and knowledge in the relevant areas only increased. Someday I hope to build off this network and focus on projects within a lab environment. Maybe I will even pentest it.