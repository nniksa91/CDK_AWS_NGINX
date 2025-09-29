import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class NetworkDiscoveryStack extends cdk.Stack {
    public readonly vpc: ec2.IVpc;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const useDefaultVpc = this.node.tryGetContext('useDefaultVpc');
        const vpcName = this.node.tryGetContext('vpcName');

        if (useDefaultVpc === 'true') {
            this.vpc = ec2.Vpc.fromLookup(this, 'LookupDefaultVpc', { isDefault: true });
        } else if (vpcName) {
            this.vpc = ec2.Vpc.fromLookup(this, 'LookupNamedVpc', { vpcName });
        } else {
            // As a safe fallback, create a new VPC with 2 AZs
            this.vpc = new ec2.Vpc(this, 'CreatedVpc', {
                maxAzs: 2,
                natGateways: 1,
                subnetConfiguration: [
                    { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
                    { name: 'private-egress', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
                ],
            });
            new cdk.CfnOutput(this, 'CreatedVpcId', { value: this.vpc.vpcId });
        }

        new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
        new cdk.CfnOutput(this, 'PublicSubnets', { value: this.vpc.publicSubnets.map(s => s.subnetId).join(',') });
        new cdk.CfnOutput(this, 'PrivateSubnets', { value: this.vpc.privateSubnets.map(s => s.subnetId).join(',') });
    }
}